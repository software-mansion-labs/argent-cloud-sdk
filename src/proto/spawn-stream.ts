/**
 * Wire framing for `simctl spawn` and `simctl` passthrough output.
 *
 * Mirrors `sim_types::spawn_stream` (the source of truth). A foreground spawn
 * — and, since router protocol v2, every `/simctl` passthrough — answers with
 * `application/x-sim-spawn-stream` rather than raw output: the process's two
 * streams stay distinguishable and its exit status rides along in a terminal
 * frame.
 *
 * Each frame is `[tag: u8][len: u32 BE][payload…]`:
 *  - `stdout` / `stderr` — `payload` is a raw output chunk;
 *  - `exit` — `payload` is `[kind: u8][value: i32 BE]` (kind 0 = exit code,
 *    1 = terminating signal, 2 = neither), the last frame on the stream.
 */

/** Marks a response body as a spawn frame stream rather than an opaque blob. */
export const SPAWN_STREAM_CONTENT_TYPE = "application/x-sim-spawn-stream";

/** Guard against a malformed length prefix forcing a huge allocation. */
export const MAX_SPAWN_FRAME_BYTES = 8 * 1024 * 1024;

const HEADER_LEN = 5;

const TAG_STDOUT = 0;
const TAG_STDERR = 1;
const TAG_EXIT = 2;

const EXIT_KIND_CODE = 0;
const EXIT_KIND_SIGNAL = 1;
const EXIT_KIND_NONE = 2;

/**
 * How a spawned process terminated. On Unix exactly one of `code`/`signal` is
 * set; both `null` means the status carried neither.
 */
export interface SpawnExit {
  code: number | null;
  signal: number | null;
}

export type SpawnFrame =
  | { kind: "stdout"; bytes: Uint8Array }
  | { kind: "stderr"; bytes: Uint8Array }
  | { kind: "exit"; exit: SpawnExit };

/**
 * A corrupt or incompatible frame stream. Terminal — a decoder that throws one
 * cannot resynchronize, so the consumer should stop reading.
 */
export class SpawnFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnFrameError";
  }
}

/**
 * Incremental decoder. Push bytes as they arrive off any byte source and pop
 * whole frames; survives frames split across arbitrary chunk boundaries.
 */
export class SpawnFrameDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
  }

  /** The next whole frame, or `null` when more bytes are needed. */
  pop(): SpawnFrame | null {
    if (this.buf.length < HEADER_LEN) return null;
    const tag = this.buf[0]!;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    const len = view.getUint32(1, false);
    if (len > MAX_SPAWN_FRAME_BYTES) {
      throw new SpawnFrameError(`spawn frame length ${len} exceeds cap`);
    }
    if (this.buf.length < HEADER_LEN + len) return null;

    const payload = this.buf.slice(HEADER_LEN, HEADER_LEN + len);
    this.buf = this.buf.slice(HEADER_LEN + len);

    switch (tag) {
      case TAG_STDOUT:
        return { kind: "stdout", bytes: payload };
      case TAG_STDERR:
        return { kind: "stderr", bytes: payload };
      case TAG_EXIT:
        return { kind: "exit", exit: decodeExit(payload) };
      default:
        throw new SpawnFrameError(`unknown spawn frame tag ${tag}`);
    }
  }

  /** Every frame currently decodable, in order. */
  drain(): SpawnFrame[] {
    const frames: SpawnFrame[] = [];
    for (let frame = this.pop(); frame !== null; frame = this.pop()) {
      frames.push(frame);
    }
    return frames;
  }

  /** Bytes buffered but not yet part of a whole frame. */
  get pending(): number {
    return this.buf.length;
  }
}

function decodeExit(payload: Uint8Array): SpawnExit {
  if (payload.length !== 5) {
    throw new SpawnFrameError(`exit frame payload was ${payload.length} bytes, expected 5`);
  }
  const kind = payload[0]!;
  const value = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getInt32(1, false);
  switch (kind) {
    case EXIT_KIND_CODE:
      return { code: value, signal: null };
    case EXIT_KIND_SIGNAL:
      return { code: null, signal: value };
    case EXIT_KIND_NONE:
      return { code: null, signal: null };
    default:
      throw new SpawnFrameError(`unknown exit kind ${kind}`);
  }
}

/**
 * A finished spawn or `simctl` run, reassembled from its frames.
 *
 * A non-zero `exit.code` is not an error at this layer: the command ran and
 * said no. Callers standing in for `xcrun simctl` write `stdout`/`stderr`
 * straight through and reproduce `exit`.
 */
export interface SpawnResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  /** Absent when the stream ended without a terminal frame (a detached spawn). */
  exit: SpawnExit | null;
}

/** Collect a whole frame stream into its two output streams plus exit status. */
export function decodeSpawnStream(bytes: Uint8Array): SpawnResult {
  const decoder = new SpawnFrameDecoder();
  decoder.push(bytes);

  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let exit: SpawnExit | null = null;

  for (const frame of decoder.drain()) {
    if (frame.kind === "stdout") stdout.push(frame.bytes);
    else if (frame.kind === "stderr") stderr.push(frame.bytes);
    else exit = frame.exit;
  }

  return { stdout: concat(stdout), stderr: concat(stderr), exit };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
