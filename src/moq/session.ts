import { Broadcast, type Connection, type Group, Path, Time, type Track } from "@moq/net";

import {
  encodeInput,
  encodeTouchState,
  type ButtonName,
  type InputMessage,
  type KeyActionName,
  type RotationName,
  type TouchActionName,
  type TouchPointer,
} from "../proto/encoder.js";
import { diffTouchStates } from "../proto/touch-state.js";
import { ScreenshotChannel, type ScreenshotOptions } from "./screenshot.js";

/** The broadcast simulator-server publishes: catalog, video and screenshot tracks. */
export const SERVER_BROADCAST = "simulator";
/** One group per frame, read latest-wins: a frame overtaken in transit is dropped. */
export const CONTROL_TRACK = "control";
const SCREENSHOT_TRACK = "screenshot";
/** One long-lived group, read in order. Named for the first event type that moved here. */
export const KEYS_TRACK = "keys";
/** Touch-state snapshots, one group per frame, latest-wins: the server diffs consecutive ones. */
export const TOUCH_TRACK = "touch";

/** Wait this long after the control subscription for keys/touch before assuming an older server. */
const TRACK_FALLBACK_GRACE_MS = 2000;

/**
 * Wraps a payload as a MoQ frame. Input frames carry no presentation time of
 * their own — they are events, not media — so they are stamped with "now",
 * which is what the wire layer wants for control state.
 */
function frame(payload: Uint8Array): Group.Frame {
  return { payload, timestamp: Time.Timestamp.now() };
}

export interface MoqDeviceSessionOptions {
  /**
   * Path of the broadcast this client publishes its control track on.
   *
   * simulator-server subscribes to the "control" track of every broadcast a
   * client announces, so the name is only an identifier — but existing clients
   * use their own, so it stays configurable.
   */
  publishPath?: string;
}

/**
 * A live MoQ session with one device: input goes out on a published control
 * track, video and screenshots come back on the server's broadcast.
 *
 * Retry policy lives with the caller — see `openWithDirectFallback` for opening
 * a connection and `closed` for noticing it went away. For video, pass
 * `connection` to `attachVideo` from `@swmansion/argent-cloud-sdk/video`.
 */
export class MoqDeviceSession {
  readonly connection: Connection.Established;
  /** Resolves when the underlying transport closes, for any reason. */
  readonly closed: Promise<void>;

  private readonly controlBroadcast = new Broadcast.Producer();
  private readonly serverBroadcast: Broadcast.Consumer;
  private screenshots: ScreenshotChannel | null = null;
  private disposed = false;

  /** Tracks the server has subscribed on our broadcast, filled as requests arrive. */
  private readonly requestedTracks = new Map<string, Track.Producer>();
  private trackWaiters = new Map<string, ((track: Track.Producer | null) => void)[]>();
  private requestPumpDone = false;

  private controlTrack: Promise<Track.Producer> | null = null;
  private orderedGroup: Promise<Group.Producer | null> | null = null;
  private touchTrack: Promise<Track.Producer | null> | null = null;
  /** Last snapshot applied through the legacy fallback, for diffing. */
  private legacyTouchApplied: TouchPointer[] = [];

  constructor(connection: Connection.Established, options: MoqDeviceSessionOptions = {}) {
    this.connection = connection;
    this.closed = connection.closed;

    this.serverBroadcast = connection.consume(Path.from(SERVER_BROADCAST));
    connection.publish(Path.from(options.publishPath ?? "input"), this.controlBroadcast);
    void this.pumpTrackRequests();

    void this.closed.then(
      () => this.screenshots?.close(new Error("MoQ connection closed")),
      (err: unknown) =>
        this.screenshots?.close(err instanceof Error ? err : new Error(String(err))),
    );
  }

  /** Sends one already-encoded `DataChannelCommand` frame on the control track. */
  async sendControl(payload: Uint8Array): Promise<void> {
    const track = await this.resolveControlTrack();
    track.writeFrame(frame(payload));
  }

  /**
   * Snapshots go to "touch", screenshot and wheel to "control", everything with
   * a Down/Up pair to the ordered "keys" group. Tracks are unordered relative to
   * each other, so do not mix `touchState` and `touch` within one gesture.
   */
  sendInput(message: InputMessage): Promise<void> {
    switch (message.type) {
      case "touchState":
        return this.touchState(message.pointers);
      case "screenshot":
      case "wheel":
        return this.sendControl(encodeInput(message));
      case "key":
      case "touch":
      case "button":
      case "rotate":
        return this.sendOrdered(encodeInput(message));
      default: {
        const unreachable: never = message;
        throw new Error(`unknown input message ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /** Full snapshot of the active pointers. For interactive gestures; programmatic taps use `touch`. */
  async touchState(pointers: TouchPointer[]): Promise<void> {
    const track = await this.resolveTouchTrack();
    if (track) {
      track.writeFrame(frame(encodeTouchState(pointers)));
      return;
    }
    // A server without "touch" predates "keys" too (both arrived together).
    const { events, applied } = diffTouchStates(this.legacyTouchApplied, pointers);
    this.legacyTouchApplied = applied;
    for (const message of events) {
      await this.sendControl(encodeInput(message));
    }
  }

  touch(action: TouchActionName, x: number, y: number, secondX?: number, secondY?: number): Promise<void> {
    return this.sendInput({ type: "touch", action, x, y, secondX, secondY });
  }

  key(action: KeyActionName, code: number): Promise<void> {
    return this.sendInput({ type: "key", action, code });
  }

  /** Ordered group, or the control track against a server without "keys". */
  private async sendOrdered(payload: Uint8Array): Promise<void> {
    const group = await this.resolveOrderedGroup();
    if (group) {
      group.writeFrame(frame(payload));
    } else {
      await this.sendControl(payload);
    }
  }

  button(action: KeyActionName, button: ButtonName): Promise<void> {
    return this.sendInput({ type: "button", action, button });
  }

  rotate(direction: RotationName): Promise<void> {
    return this.sendInput({ type: "rotate", direction });
  }

  wheel(x: number, y: number, dx: number, dy: number): Promise<void> {
    return this.sendInput({ type: "wheel", x, y, dx, dy });
  }

  /**
   * Requests one screenshot and resolves with the image bytes.
   *
   * The screenshot track is subscribed on first use, so a client that only
   * watches video never opens a subscription it won't read.
   */
  screenshot(options?: ScreenshotOptions): Promise<Uint8Array> {
    if (this.disposed) {
      return Promise.reject(new Error("MoQ session is closed"));
    }
    this.screenshots ??= new ScreenshotChannel(
      this.serverBroadcast.subscribe(SCREENSHOT_TRACK),
      (payload) => this.sendControl(payload),
    );
    return this.screenshots.request(options);
  }

  /** Subscribes to a track on the server's broadcast (video, catalog.json). */
  subscribe(name: string, priority = 0): Track.Subscriber {
    return this.serverBroadcast.subscribe(name, { priority });
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.screenshots?.close(new Error("MoQ session closed"));
    // Both may already be closed if the transport dropped first; that isn't an
    // error worth propagating out of a teardown path.
    try {
      this.controlBroadcast.close();
    } catch {
      /* already closed */
    }
    try {
      this.connection.close();
    } catch {
      /* already closed */
    }
  }

  /**
   * Collects every track the server subscribes on our broadcast. The server
   * subscribes "control" plus (if it speaks the split protocol) "keys" and
   * "touch" when it sees the announcement, so requests arrive together, but in
   * no guaranteed order.
   */
  private async pumpTrackRequests(): Promise<void> {
    try {
      for (;;) {
        const request = await this.controlBroadcast.requested();
        if (!request) break;
        // Accepting commits the track and hands back its producer; the
        // server's subscription stays pending until we do.
        const track = request.accept();
        this.requestedTracks.set(track.name, track);
        const waiters = this.trackWaiters.get(track.name);
        if (waiters) {
          this.trackWaiters.delete(track.name);
          for (const resolve of waiters) resolve(track);
        }
      }
    } catch {
      /* broadcast closed — fall through to waiter cleanup */
    }
    this.requestPumpDone = true;
    const pending = this.trackWaiters;
    this.trackWaiters = new Map();
    for (const waiters of pending.values()) {
      for (const resolve of waiters) resolve(null);
    }
  }

  /** Resolves once the server subscribes `name`; null if the broadcast closes first. */
  private waitForTrack(name: string): Promise<Track.Producer | null> {
    const track = this.requestedTracks.get(name);
    if (track) return Promise.resolve(track);
    if (this.requestPumpDone) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiters = this.trackWaiters.get(name) ?? [];
      waiters.push(resolve);
      this.trackWaiters.set(name, waiters);
    });
  }

  /**
   * The track once the server subscribes it, or null if it has not within the
   * grace period after the control subscription: a server that speaks the split
   * protocol subscribes all tracks together.
   */
  private waitForOptionalTrack(name: string): Promise<Track.Producer | null> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (track: Track.Producer | null) => {
        if (!settled) {
          settled = true;
          resolve(track);
        }
      };
      void this.waitForTrack(name).then(settle);
      void this.resolveControlTrack().then(
        () => setTimeout(() => settle(this.requestedTracks.get(name) ?? null), TRACK_FALLBACK_GRACE_MS),
        () => settle(null),
      );
    });
  }

  /**
   * The server subscribes to our control track once it sees the announcement,
   * so the first send may have to wait for it. Cache the resolved track so
   * every later send is immediate.
   */
  private resolveControlTrack(): Promise<Track.Producer> {
    this.controlTrack ??= this.waitForTrack(CONTROL_TRACK).then((track) => {
      if (!track) {
        throw new Error("MoQ control broadcast closed before the server subscribed");
      }
      return track;
    });
    return this.controlTrack;
  }

  /**
   * The one group every ordered send awaits, so call order is write order. A
   * reader the wire layer drops mid-session (stream reset) is not recovered.
   */
  private resolveOrderedGroup(): Promise<Group.Producer | null> {
    this.orderedGroup ??= this.waitForOptionalTrack(KEYS_TRACK).then(
      (track) => track?.appendGroup() ?? null,
    );
    return this.orderedGroup;
  }

  private resolveTouchTrack(): Promise<Track.Producer | null> {
    this.touchTrack ??= this.waitForOptionalTrack(TOUCH_TRACK);
    return this.touchTrack;
  }
}
