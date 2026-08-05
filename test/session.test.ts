import { describe, expect, it, vi } from "vitest";

import { MoqDeviceSession } from "../src/moq/session.js";

/**
 * Stands in for the pieces of `@moq/net` a session touches: a published
 * broadcast the "server" subscribes to, and a consumed broadcast whose tracks
 * the test can inspect.
 */
function fakeConnection() {
  const published: { path: string; broadcast: FakeBroadcast }[] = [];
  const subscribed: { name: string; priority: number }[] = [];
  let closedResolve: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  const serverBroadcast = {
    subscribe(name: string, priority: number) {
      subscribed.push({ name, priority });
      return { name, readFrame: () => new Promise(() => {}) };
    },
  };

  const connection = {
    closed,
    close: vi.fn(),
    consume: () => serverBroadcast,
    publish: (path: string, broadcast: FakeBroadcast) => {
      published.push({ path, broadcast });
    },
  };

  return { connection, published, subscribed, closeConnection: closedResolve };
}

interface FakeBroadcast {
  requested(): Promise<{ track: FakeTrack } | undefined>;
  close(): void;
}

/** A track the fake server has subscribed on the session's broadcast. */
class FakeTrack {
  readonly frames: Uint8Array[] = [];
  readonly groups: { frames: Uint8Array[]; writeFrame(f: Uint8Array): void }[] = [];

  constructor(
    readonly name: string,
    private readonly all: Uint8Array[],
  ) {}

  writeFrame(f: Uint8Array) {
    this.frames.push(f);
    this.all.push(f);
  }

  appendGroup() {
    const frames: Uint8Array[] = [];
    const group = { frames, writeFrame: (f: Uint8Array) => frames.push(f) };
    this.groups.push(group);
    return group;
  }
}

/** Replaces the Broadcast the session constructs for its control track. */
class FakeControlBroadcast implements FakeBroadcast {
  /** Frames written to any track, in send order (legacy assertions). */
  readonly frames: Uint8Array[] = [];
  closed = false;
  private requests: { track: FakeTrack }[] = [];
  private waiter: ((r: { track: FakeTrack } | undefined) => void) | null = null;

  requested() {
    const next = this.requests.shift();
    if (next) return Promise.resolve(next);
    return new Promise<{ track: FakeTrack } | undefined>((resolve) => {
      this.waiter = resolve;
    });
  }

  /** Simulates the server subscribing to a track on our broadcast. */
  serverSubscribes(name: string): FakeTrack {
    const track = new FakeTrack(name, this.frames);
    const request = { track };
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(request);
    } else {
      this.requests.push(request);
    }
    return track;
  }

  close() {
    this.closed = true;
  }
}

vi.mock("@moq/net", () => ({
  Broadcast: class {
    constructor() {
      return controlBroadcast;
    }
  },
  Path: { from: (p: string) => p },
  Connection: {},
}));

let controlBroadcast: FakeControlBroadcast;

function newSession(publishPath?: string) {
  controlBroadcast = new FakeControlBroadcast();
  const fake = fakeConnection();
  const session = new MoqDeviceSession(
    fake.connection as never,
    publishPath ? { publishPath } : {},
  );
  return { session, ...fake, control: controlBroadcast };
}

describe("MoqDeviceSession", () => {
  it("publishes on 'input' by default", () => {
    const { published } = newSession();
    expect(published[0]?.path).toBe("input");
  });

  it("publishes on the configured path", () => {
    const { published } = newSession("argent");
    expect(published[0]?.path).toBe("argent");
  });

  it("waits for the server to subscribe before sending input", async () => {
    const { session, control } = newSession();

    const sent = session.button("Down", "home");
    expect(control.frames).toHaveLength(0);

    control.serverSubscribes("control");
    await sent;
    expect(control.frames).toHaveLength(1);
  });

  it("ignores subscriptions to tracks other than 'control'", async () => {
    const { session, control } = newSession();

    const sent = session.rotate("LandscapeLeft");
    control.serverSubscribes("something-else");
    control.serverSubscribes("control");
    await sent;

    expect(control.frames).toHaveLength(1);
  });

  it("resolves the control track once and reuses it", async () => {
    const { session, control } = newSession();

    const first = session.touch("Down", 0.5, 0.5);
    control.serverSubscribes("control");
    await first;
    await session.touch("Up", 0.5, 0.5);

    expect(control.frames).toHaveLength(2);
  });

  it("does not subscribe to the screenshot track until a screenshot is asked for", () => {
    const { session, subscribed } = newSession();
    expect(subscribed).toHaveLength(0);

    void session.screenshot().catch(() => {});
    expect(subscribed).toEqual([{ name: "screenshot", priority: 0 }]);
  });

  it("closes the control broadcast and the connection", () => {
    const { session, connection, control } = newSession();
    session.close();

    expect(control.closed).toBe(true);
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("closes only once", () => {
    const { session, connection } = newSession();
    session.close();
    session.close();

    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("rejects a screenshot requested after close", async () => {
    const { session } = newSession();
    session.close();
    await expect(session.screenshot()).rejects.toThrow(/closed/);
  });

  it("fails an in-flight screenshot when the connection drops", async () => {
    const { session, closeConnection } = newSession();

    const pending = session.screenshot();
    closeConnection();

    await expect(pending).rejects.toThrow(/connection closed/i);
  });

  it("sends all key events as frames of one group on the keys track", async () => {
    const { session, control } = newSession();

    const first = session.key("Down", 0x04);
    control.serverSubscribes("control");
    const keys = control.serverSubscribes("keys");
    await first;
    await session.key("Up", 0x04);
    await session.key("Down", 0x05);

    expect(keys.groups).toHaveLength(1);
    expect(keys.groups[0]?.frames).toHaveLength(3);
    expect(control.serverSubscribes("control").frames).toHaveLength(0);
  });

  it("falls back to control-track key frames when the server never subscribes 'keys'", async () => {
    vi.useFakeTimers();
    try {
      const { session, control } = newSession();

      const sent = session.key("Down", 0x04);
      const controlTrack = control.serverSubscribes("control");
      await vi.advanceTimersByTimeAsync(2500);
      await sent;

      expect(controlTrack.frames).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends touch snapshots as individual frames on the touch track", async () => {
    const { session, control } = newSession();

    const first = session.touchState([{ id: 1, x: 0.5, y: 0.5 }]);
    control.serverSubscribes("control");
    const touch = control.serverSubscribes("touch");
    await first;
    await session.touchState([]);

    expect(touch.frames).toHaveLength(2);
    expect(touch.groups).toHaveLength(0);
  });

  it("converts touch snapshots to legacy events when the server never subscribes 'touch'", async () => {
    vi.useFakeTimers();
    try {
      const { session, control } = newSession();

      const sent = session.touchState([{ id: 1, x: 0.5, y: 0.5 }]);
      const controlTrack = control.serverSubscribes("control");
      await vi.advanceTimersByTimeAsync(2500);
      await sent;
      await session.touchState([{ id: 1, x: 0.6, y: 0.6 }]);
      await session.touchState([]);

      // Down, Move, Up as three legacy control frames.
      expect(controlTrack.frames).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes touchState and key InputMessages through sendInput", async () => {
    const { session, control } = newSession();

    const first = session.sendInput({ type: "key", action: "Down", code: 0x04 });
    control.serverSubscribes("control");
    const keys = control.serverSubscribes("keys");
    const touch = control.serverSubscribes("touch");
    await first;
    await session.sendInput({ type: "touchState", pointers: [{ id: 0, x: 0.1, y: 0.2 }] });

    expect(keys.groups[0]?.frames).toHaveLength(1);
    expect(touch.frames).toHaveLength(1);
  });
});
