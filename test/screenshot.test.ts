import type { Track } from "@moq/net";
import { describe, expect, it } from "vitest";

import { ScreenshotChannel } from "../src/moq/screenshot.js";

/** A `Track` stand-in whose frames are pushed by the test. */
class FakeTrack {
  private readonly queue: Uint8Array[] = [];
  private waiter: ((frame: Uint8Array | undefined) => void) | null = null;

  readFrame(): Promise<Uint8Array | undefined> {
    const next = this.queue.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  push(payload: unknown): void {
    const frame = new TextEncoder().encode(JSON.stringify(payload));
    this.deliver(frame);
  }

  pushRaw(frame: Uint8Array): void {
    this.deliver(frame);
  }

  end(): void {
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) waiter(undefined);
  }

  private deliver(frame: Uint8Array): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(frame);
      return;
    }
    this.queue.push(frame);
  }

  asTrack(): Track {
    return this as unknown as Track;
  }
}

function base64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Lets the channel's reader loop drain whatever the test just pushed. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ScreenshotChannel", () => {
  it("sends a command carrying the request id and resolves with the image bytes", async () => {
    const track = new FakeTrack();
    const sent: Uint8Array[] = [];
    const channel = new ScreenshotChannel(track.asTrack(), async (payload) => {
      sent.push(payload);
    });

    const pending = channel.request();
    await flush();

    expect(sent).toHaveLength(1);
    // ScreenshotCommand is oneof field 6; its `id` is field 1 (a string).
    expect(sent[0]?.[0]).toBe((6 << 3) | 2);
    expect(new TextDecoder().decode(sent[0]!)).toContain("1");

    track.push({ id: "1", data: base64([1, 2, 3]) });
    expect(Array.from(await pending)).toEqual([1, 2, 3]);
  });

  it("matches concurrent requests by id, whatever order they answer in", async () => {
    const track = new FakeTrack();
    const channel = new ScreenshotChannel(track.asTrack(), async () => {});

    const first = channel.request();
    const second = channel.request();
    await flush();

    track.push({ id: "2", data: base64([2, 2]) });
    track.push({ id: "1", data: base64([1, 1]) });

    expect(Array.from(await first)).toEqual([1, 1]);
    expect(Array.from(await second)).toEqual([2, 2]);
  });

  it("hands an id-less frame to the oldest waiter, for servers that don't echo ids", async () => {
    const track = new FakeTrack();
    const channel = new ScreenshotChannel(track.asTrack(), async () => {});

    const first = channel.request();
    const second = channel.request();
    await flush();

    track.push({ data: base64([10]) });
    track.push({ data: base64([20]) });

    expect(Array.from(await first)).toEqual([10]);
    expect(Array.from(await second)).toEqual([20]);
  });

  it("ignores a response nobody is waiting for", async () => {
    const track = new FakeTrack();
    const channel = new ScreenshotChannel(track.asTrack(), async () => {});

    const pending = channel.request();
    await flush();

    track.push({ id: "99", data: base64([9]) });
    track.push({ id: "1", data: base64([1]) });

    expect(Array.from(await pending)).toEqual([1]);
  });

  it("rejects in-flight requests when the track closes", async () => {
    const track = new FakeTrack();
    const channel = new ScreenshotChannel(track.asTrack(), async () => {});

    const pending = channel.request();
    await flush();
    track.end();

    await expect(pending).rejects.toThrow(/closed before frame arrived/);
  });

  it("rejects a request whose command could not be sent", async () => {
    const track = new FakeTrack();
    const channel = new ScreenshotChannel(track.asTrack(), async () => {
      throw new Error("control track gone");
    });

    await expect(channel.request()).rejects.toThrow("control track gone");
  });

  it("rejects on a frame that is not valid JSON", async () => {
    const track = new FakeTrack();
    const channel = new ScreenshotChannel(track.asTrack(), async () => {});

    const pending = channel.request();
    await flush();
    track.pushRaw(new Uint8Array([0xff, 0xfe]));

    await expect(pending).rejects.toThrow(/not valid JSON/);
  });

  it("rejects on a frame with no data field", async () => {
    const track = new FakeTrack();
    const channel = new ScreenshotChannel(track.asTrack(), async () => {});

    const pending = channel.request();
    await flush();
    track.push({ id: "1" });

    await expect(pending).rejects.toThrow(/missing 'data' field/);
  });

  it("refuses new requests once closed", async () => {
    const channel = new ScreenshotChannel(new FakeTrack().asTrack(), async () => {});
    channel.close();
    await expect(channel.request()).rejects.toThrow(/closed/);
  });

  it("forwards screenshot options into the command", async () => {
    const send = async (payload: Uint8Array) => {
      sent.push(payload);
    };
    const sent: Uint8Array[] = [];

    void new ScreenshotChannel(new FakeTrack().asTrack(), send).request();
    void new ScreenshotChannel(new FakeTrack().asTrack(), send).request({
      scale: 0.5,
      rotation: "LandscapeLeft",
    });
    await flush();

    const [plain, withOptions] = sent;
    // scale adds a 5-byte f32 field and rotation a 2-byte enum field.
    expect(withOptions!.length).toBe(plain!.length + 7);
  });

  it("rejects everything in flight when closed explicitly", async () => {
    const track = new FakeTrack();
    const channel = new ScreenshotChannel(track.asTrack(), async () => {});

    const first = channel.request();
    const second = channel.request();
    await flush();
    channel.close(new Error("session gone"));

    await expect(first).rejects.toThrow("session gone");
    await expect(second).rejects.toThrow("session gone");
  });
});
