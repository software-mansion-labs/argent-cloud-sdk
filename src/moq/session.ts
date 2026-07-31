import { Broadcast, Connection, Path, type Track } from "@moq/net";

import {
  encodeInput,
  type ButtonName,
  type InputMessage,
  type KeyActionName,
  type RotationName,
  type TouchActionName,
} from "../proto/encoder.js";
import { ScreenshotChannel, type ScreenshotOptions } from "./screenshot.js";

/** The broadcast simulator-server publishes: catalog, video and screenshot tracks. */
export const SERVER_BROADCAST = "simulator";
/** The track name the server subscribes to on a client-published broadcast. */
export const CONTROL_TRACK = "control";
const SCREENSHOT_TRACK = "screenshot";

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
 * `connection` to `attachVideo` from `@swmansion/sim-client/video`.
 */
export class MoqDeviceSession {
  readonly connection: Connection.Established;
  /** Resolves when the underlying transport closes, for any reason. */
  readonly closed: Promise<void>;

  private readonly controlBroadcast = new Broadcast();
  private readonly serverBroadcast: Broadcast;
  private screenshots: ScreenshotChannel | null = null;
  private controlTrack: Promise<Track> | null = null;
  private disposed = false;

  constructor(connection: Connection.Established, options: MoqDeviceSessionOptions = {}) {
    this.connection = connection;
    this.closed = connection.closed;

    this.serverBroadcast = connection.consume(Path.from(SERVER_BROADCAST));
    connection.publish(Path.from(options.publishPath ?? "input"), this.controlBroadcast);

    void this.closed.then(
      () => this.screenshots?.close(new Error("MoQ connection closed")),
      (err: unknown) =>
        this.screenshots?.close(err instanceof Error ? err : new Error(String(err))),
    );
  }

  /** Sends one already-encoded `DataChannelCommand` frame. */
  async sendControl(payload: Uint8Array): Promise<void> {
    const track = await this.resolveControlTrack();
    track.writeFrame(payload);
  }

  /** Encodes and sends an input event. */
  sendInput(message: InputMessage): Promise<void> {
    return this.sendControl(encodeInput(message));
  }

  touch(action: TouchActionName, x: number, y: number, secondX?: number, secondY?: number): Promise<void> {
    return this.sendInput({ type: "touch", action, x, y, secondX, secondY });
  }

  key(action: KeyActionName, code: number): Promise<void> {
    return this.sendInput({ type: "key", action, code });
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
      this.serverBroadcast.subscribe(SCREENSHOT_TRACK, 0),
      (payload) => this.sendControl(payload),
    );
    return this.screenshots.request(options);
  }

  /** Subscribes to a track on the server's broadcast (video, catalog.json). */
  subscribe(name: string, priority = 0): Track {
    return this.serverBroadcast.subscribe(name, priority);
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
   * The server subscribes to our control track once it sees the announcement,
   * so the first send may have to wait for it. Cache the resolved track so
   * every later send is immediate.
   */
  private resolveControlTrack(): Promise<Track> {
    if (this.controlTrack) return this.controlTrack;
    this.controlTrack = (async () => {
      for (;;) {
        const request = await this.controlBroadcast.requested();
        if (!request) {
          throw new Error("MoQ control broadcast closed before the server subscribed");
        }
        // Ignore anything else the server might ask for in the future.
        if (request.track.name === CONTROL_TRACK) return request.track;
      }
    })();
    return this.controlTrack;
  }
}
