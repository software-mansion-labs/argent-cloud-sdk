import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Time } from "@moq/net";
import type { Signals } from "@moq/watch";

// `@moq/watch` needs the DOM, so stand in for the one class under test's parent.
vi.mock("@moq/watch", () => ({
  Sync: class {
    out = { buffer: { peek: () => Time.Milli(100) } };
    received(): void {}
    reset(): void {}
    close(): void {}
  },
}));

const { BACKLOG_SLACK, LiveEdgeSync, paintLiveFrames } = await import("../src/moq/live-frames.js");

describe("LiveEdgeSync", () => {
  const ms = (value: number) => Time.Milli(value);

  it("treats every frame as live until one has been received", () => {
    const sync = new LiveEdgeSync();
    expect(sync.isBacklog(ms(0))).toBe(false);
  });

  it("allows a frame one buffer plus the slack behind the newest one", () => {
    const sync = new LiveEdgeSync();
    sync.received(ms(10_000));
    const budget = 100 + BACKLOG_SLACK;
    expect(sync.isBacklog(ms(10_000 - budget))).toBe(false);
    expect(sync.isBacklog(ms(10_000 - budget - 1))).toBe(true);
  });

  it("keeps the live edge at the newest timestamp, not the last one received", () => {
    const sync = new LiveEdgeSync();
    sync.received(ms(10_000));
    sync.received(ms(2_000));
    expect(sync.isBacklog(ms(2_000))).toBe(true);
  });

  it("forgets the live edge on a rewind", () => {
    const sync = new LiveEdgeSync();
    sync.received(ms(10_000));
    sync.reset();
    expect(sync.isBacklog(ms(0))).toBe(false);
  });
});

describe("paintLiveFrames", () => {
  type Subscriber = (frame: VideoFrame | undefined) => void;

  let subscribers: Set<Subscriber>;
  let frames: Signals.Getter<VideoFrame | undefined>;
  let animations: Map<number, FrameRequestCallback>;
  let nextAnimation: number;
  let drawImage: ReturnType<typeof vi.fn>;
  let canvas: HTMLCanvasElement;

  const emit = (frame: VideoFrame | undefined) => {
    for (const fn of subscribers) fn(frame);
  };

  const tick = () => {
    const due = [...animations.values()];
    animations.clear();
    for (const fn of due) fn(0);
  };

  interface FakeFrame {
    timestamp: number;
    closed: boolean;
    clones: FakeFrame[];
    clone(): FakeFrame;
    close(): void;
  }

  const frame = (timestampMs: number): FakeFrame & VideoFrame => {
    const make = (): FakeFrame => ({
      timestamp: Time.Milli.toMicro(Time.Milli(timestampMs)),
      closed: false,
      clones: [],
      clone() {
        const clone = make();
        this.clones.push(clone);
        return clone;
      },
      close() {
        this.closed = true;
      },
    });
    return make() as unknown as FakeFrame & VideoFrame;
  };

  beforeEach(() => {
    subscribers = new Set();
    frames = {
      peek: () => undefined,
      changed: (() => Promise.resolve(undefined)) as Signals.Getter<VideoFrame | undefined>["changed"],
      subscribe(fn: Subscriber) {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
    };
    animations = new Map();
    nextAnimation = 1;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      const id = nextAnimation++;
      animations.set(id, fn);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      animations.delete(id);
    });
    drawImage = vi.fn();
    canvas = { width: 390, height: 844, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const live = { isBacklog: () => false };
  const backlog = { isBacklog: () => true };

  it("paints a live frame on the next animation frame and closes its clone", () => {
    paintLiveFrames(frames, live, canvas);
    const f = frame(1_000);
    emit(f);
    expect(drawImage).not.toHaveBeenCalled();
    tick();
    expect(drawImage).toHaveBeenCalledWith(f.clones[0], 0, 0, 390, 844);
    expect(f.clones[0]?.closed).toBe(true);
    expect(f.closed).toBe(false);
  });

  it("does not paint a backlog frame", () => {
    paintLiveFrames(frames, backlog, canvas);
    const f = frame(1_000);
    emit(f);
    tick();
    expect(drawImage).not.toHaveBeenCalled();
    expect(animations.size).toBe(0);
    expect(f.clones).toHaveLength(0);
  });

  it("asks about each frame's own timestamp", () => {
    const isBacklog = vi.fn(() => false);
    paintLiveFrames(frames, { isBacklog }, canvas);
    emit(frame(1_234));
    expect(isBacklog).toHaveBeenCalledWith(Time.Milli(1_234));
  });

  it("paints only the newest of several frames released before one animation frame", () => {
    paintLiveFrames(frames, live, canvas);
    const first = frame(1_000);
    const second = frame(1_016);
    emit(first);
    emit(second);
    tick();
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(second.clones[0], 0, 0, 390, 844);
    expect(first.clones[0]?.closed).toBe(true);
  });

  it("drops the pending frame when the decoder clears its frame", () => {
    paintLiveFrames(frames, live, canvas);
    const f = frame(1_000);
    emit(f);
    emit(undefined);
    tick();
    expect(drawImage).not.toHaveBeenCalled();
    expect(f.clones[0]?.closed).toBe(true);
  });

  it("stops painting and releases the pending frame when stopped", () => {
    const stop = paintLiveFrames(frames, live, canvas);
    const f = frame(1_000);
    emit(f);
    stop();
    expect(animations.size).toBe(0);
    expect(f.clones[0]?.closed).toBe(true);
    expect(subscribers.size).toBe(0);
    emit(frame(2_000));
    tick();
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("refuses a canvas without a 2d context", () => {
    const bare = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => paintLiveFrames(frames, live, bare)).toThrow(/2d context/);
  });
});
