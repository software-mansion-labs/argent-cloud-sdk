/**
 * Wire framing for live build-log streaming.
 *
 * Mirrors `sim_types::build_stream`. Same `[tag: u8][len: u32 BE][payload…]`
 * shape as the spawn stream, with a build-specific terminal frame: the build's
 * `BuildResult`, not a bare exit code, because a build can fail for reasons no
 * exit status expresses (timeout, cancellation, host disconnect).
 */

import type { BuildResult } from "../types.js";

/** Content type of the `POST /builds` response body. */
export const BUILD_STREAM_CONTENT_TYPE = "application/x-sim-build-stream";

/**
 * Response header on `POST /builds` carrying the assigned build id. Sent with
 * the headers — before any body byte — so a client can cancel or query a build
 * whose log stream is still open.
 */
export const BUILD_ID_HEADER = "x-build-id";

/** Guard against a malformed length prefix forcing a huge allocation. */
export const MAX_BUILD_FRAME_BYTES = 8 * 1024 * 1024;

const HEADER_LEN = 5;

const TAG_STDOUT = 0;
const TAG_STDERR = 1;
const TAG_RESULT = 2;

export type BuildFrame =
  | { kind: "stdout"; bytes: Uint8Array }
  | { kind: "stderr"; bytes: Uint8Array }
  /** Terminal frame: the build's outcome. Nothing follows it. */
  | { kind: "result"; result: BuildResult };

/** A corrupt or incompatible build frame stream. Terminal. */
export class BuildFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildFrameError";
  }
}

/** Incremental decoder; survives frames split across chunk boundaries. */
export class BuildFrameDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
  }

  /** The next whole frame, or `null` when more bytes are needed. */
  pop(): BuildFrame | null {
    if (this.buf.length < HEADER_LEN) return null;
    const tag = this.buf[0]!;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    const len = view.getUint32(1, false);
    if (len > MAX_BUILD_FRAME_BYTES) {
      throw new BuildFrameError(`build frame length ${len} exceeds cap`);
    }
    if (this.buf.length < HEADER_LEN + len) return null;

    const payload = this.buf.slice(HEADER_LEN, HEADER_LEN + len);
    this.buf = this.buf.slice(HEADER_LEN + len);

    switch (tag) {
      case TAG_STDOUT:
        return { kind: "stdout", bytes: payload };
      case TAG_STDERR:
        return { kind: "stderr", bytes: payload };
      case TAG_RESULT:
        return { kind: "result", result: decodeResult(payload) };
      default:
        throw new BuildFrameError(`unknown build frame tag ${tag}`);
    }
  }

  drain(): BuildFrame[] {
    const frames: BuildFrame[] = [];
    for (let frame = this.pop(); frame !== null; frame = this.pop()) {
      frames.push(frame);
    }
    return frames;
  }

  get pending(): number {
    return this.buf.length;
  }
}

function decodeResult(payload: Uint8Array): BuildResult {
  const text = new TextDecoder().decode(payload);
  try {
    return JSON.parse(text) as BuildResult;
  } catch (cause) {
    throw new BuildFrameError(`result frame payload malformed: ${String(cause)}`);
  }
}

/**
 * Decode a build log stream as it arrives, yielding frames.
 *
 * The point of `POST /builds` streaming its own logs is to show them while the
 * build runs, so this consumes a `ReadableStream` rather than a finished
 * buffer. The terminal `result` frame is the last one yielded.
 */
export async function* decodeBuildStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<BuildFrame> {
  const decoder = new BuildFrameDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        decoder.push(value);
        yield* decoder.drain();
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
