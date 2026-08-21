import { describe, expect, it } from "vitest";

import { SimulatorApi } from "../src/http/simulator-api.js";
import { makeProxyTransport } from "../src/http/transport.js";
import {
  SpawnFrameDecoder,
  SpawnFrameError,
  decodeSpawnStream,
} from "../src/proto/spawn-stream.js";

/** Encode one `[tag][len BE][payload]` frame, as `sim_types::spawn_stream` does. */
function frame(tag: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = tag;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);
const stdout = (s: string) => frame(0, text(s));
const stderr = (s: string) => frame(1, text(s));

function exitCode(code: number): Uint8Array {
  const payload = new Uint8Array(5);
  payload[0] = 0;
  new DataView(payload.buffer).setInt32(1, code, false);
  return frame(2, payload);
}

function exitSignal(signal: number): Uint8Array {
  const payload = new Uint8Array(5);
  payload[0] = 1;
  new DataView(payload.buffer).setInt32(1, signal, false);
  return frame(2, payload);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("decodeSpawnStream", () => {
  it("separates the two streams and reads the exit code", () => {
    const result = decodeSpawnStream(
      concat(stdout("hello "), stderr("warn"), stdout("world"), exitCode(3)),
    );

    expect(new TextDecoder().decode(result.stdout)).toBe("hello world");
    expect(new TextDecoder().decode(result.stderr)).toBe("warn");
    expect(result.exit).toEqual({ code: 3, signal: null });
  });

  it("reads a signalled exit", () => {
    expect(decodeSpawnStream(exitSignal(9)).exit).toEqual({ code: null, signal: 9 });
  });

  it("reports no exit for a body that carried none", () => {
    // A detached spawn answers with an empty body.
    expect(decodeSpawnStream(new Uint8Array(0))).toEqual({
      stdout: new Uint8Array(0),
      stderr: new Uint8Array(0),
      exit: null,
    });
  });

  it("preserves bytes that are not valid UTF-8", () => {
    const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    expect(Array.from(decodeSpawnStream(frame(0, raw)).stdout)).toEqual(Array.from(raw));
  });
});

describe("SpawnFrameDecoder", () => {
  it("reassembles frames split across chunk boundaries", () => {
    const whole = concat(stdout("abc"), exitCode(0));
    const decoder = new SpawnFrameDecoder();
    const frames = [];

    // One byte at a time — the worst split the transport could hand us.
    for (const byte of whole) {
      decoder.push(new Uint8Array([byte]));
      frames.push(...decoder.drain());
    }

    expect(frames).toEqual([
      { kind: "stdout", bytes: text("abc") },
      { kind: "exit", exit: { code: 0, signal: null } },
    ]);
    expect(decoder.pending).toBe(0);
  });

  it("yields nothing until a frame is whole", () => {
    const decoder = new SpawnFrameDecoder();
    decoder.push(stdout("abcdef").slice(0, 6));
    expect(decoder.pop()).toBeNull();
    expect(decoder.pending).toBe(6);
  });

  it("throws on an unknown tag", () => {
    const decoder = new SpawnFrameDecoder();
    decoder.push(frame(7, text("x")));
    expect(() => decoder.pop()).toThrow(SpawnFrameError);
  });

  it("throws on a length prefix past the cap", () => {
    const bogus = new Uint8Array([0, 0xff, 0xff, 0xff, 0xff]);
    const decoder = new SpawnFrameDecoder();
    decoder.push(bogus);
    expect(() => decoder.pop()).toThrow(SpawnFrameError);
  });
});

describe("simctl over the frame stream", () => {
  it("returns a non-zero exit as a successful call, not a rejection", async () => {
    const body = concat(stderr("Invalid device\n"), exitCode(164));
    const fetchImpl = (async () => new Response(body)) as unknown as typeof fetch;
    const api = new SimulatorApi(makeProxyTransport("/api", { fetch: fetchImpl }));

    const result = await api.simctl(["boot", "NOPE"]);

    expect(result.exit).toEqual({ code: 164, signal: null });
    expect(new TextDecoder().decode(result.stderr)).toBe("Invalid device\n");
  });

  it("decodes a spawn's output the same way", async () => {
    const body = concat(stdout("ok\n"), exitCode(0));
    const fetchImpl = (async () => new Response(body)) as unknown as typeof fetch;
    const api = new SimulatorApi(makeProxyTransport("/api", { fetch: fetchImpl }));

    const result = await api.spawn("UDID", { args: ["/bin/echo", "ok"] });

    expect(new TextDecoder().decode(result.stdout)).toBe("ok\n");
    expect(result.exit).toEqual({ code: 0, signal: null });
  });
});
