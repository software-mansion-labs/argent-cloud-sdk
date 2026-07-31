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
  requested(): Promise<{ track: { name: string; writeFrame(f: Uint8Array): void } } | undefined>;
  close(): void;
}

/** Replaces the Broadcast the session constructs for its control track. */
class FakeControlBroadcast implements FakeBroadcast {
  readonly frames: Uint8Array[] = [];
  closed = false;
  private requests: { track: { name: string; writeFrame(f: Uint8Array): void } }[] = [];
  private waiter: ((r: { track: { name: string; writeFrame(f: Uint8Array): void } } | undefined) => void) | null = null;

  requested() {
    const next = this.requests.shift();
    if (next) return Promise.resolve(next);
    return new Promise<{ track: { name: string; writeFrame(f: Uint8Array): void } } | undefined>(
      (resolve) => {
        this.waiter = resolve;
      },
    );
  }

  /** Simulates the server subscribing to a track on our broadcast. */
  serverSubscribes(name: string) {
    const request = {
      track: { name, writeFrame: (f: Uint8Array) => this.frames.push(f) },
    };
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(request);
      return;
    }
    this.requests.push(request);
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
});
