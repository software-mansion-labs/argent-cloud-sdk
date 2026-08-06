import type { Track } from "@moq/net";

import { encodeScreenshot, type DownscalerName, type RotationName } from "../proto/encoder.js";

export interface ScreenshotOptions {
  rotation?: RotationName;
  scale?: number;
  downscaler?: DownscalerName;
}

interface Pending {
  id: string;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
}

/** How long to wait for a response before giving up on a request. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Request/response channel layered over the MoQ control and "screenshot"
 * tracks: the request goes out as a `ScreenshotCommand` carrying an id, and the
 * server echoes that id back on the shared screenshot track alongside the
 * base64 image.
 *
 * Requests are issued one at a time — see `request` for why. The echoed id is
 * still matched, so a late or duplicate frame can't be handed to the wrong
 * waiter; a server too old to echo it goes to the oldest waiter instead, which
 * is correct given requests are answered in order.
 */
export class ScreenshotChannel {
  private readonly pending: Pending[] = [];
  private nextId = 0;
  private reading = false;
  private closed = false;
  /** Why the channel closed, so queued requests fail for the same reason. */
  private closeReason: Error | null = null;
  /** Tail of the request queue; see `request`. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly track: Track,
    private readonly sendControl: (payload: Uint8Array) => Promise<void>,
    private readonly timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  /**
   * Requests one screenshot.
   *
   * Requests are issued one at a time. simulator-server answers a single
   * screenshot per session at a time — send it a second request before the
   * first is answered and only one response comes back, so an unserialised
   * caller waits forever. Queuing here keeps concurrent callers correct, and
   * the id on each request still guards against a stale frame being handed to
   * the wrong waiter.
   */
  request(options: ScreenshotOptions = {}): Promise<Uint8Array> {
    if (this.closed) {
      return Promise.reject(this.closedError());
    }
    const run = () => this.send(options);
    const result = this.queue.then(run, run);
    // Keep the queue advancing even when a request fails.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private send(options: ScreenshotOptions): Promise<Uint8Array> {
    if (this.closed) {
      return Promise.reject(this.closedError());
    }

    const id = String(++this.nextId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = new Promise<Uint8Array>((resolve, reject) => {
      this.pending.push({ id, resolve, reject });
      // A dropped response must surface as an error, not an unresolved promise.
      timer = setTimeout(() => {
        this.settle(id, new Error(`MoQ screenshot timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    this.startReading();

    this.sendControl(encodeScreenshot({ ...options, id })).catch((err: unknown) => {
      this.settle(id, err instanceof Error ? err : new Error(String(err)));
    });

    return result.finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** Fails every in-flight request; call when the session goes away. */
  close(reason?: Error): void {
    this.closed = true;
    const error = reason ?? new Error("MoQ screenshot channel is closed");
    this.closeReason = error;
    while (this.pending.length > 0) {
      this.pending.shift()?.reject(error);
    }
  }

  private closedError(): Error {
    return this.closeReason ?? new Error("MoQ screenshot channel is closed");
  }

  private startReading(): void {
    if (this.reading) return;
    this.reading = true;

    void (async () => {
      try {
        for (;;) {
          const frame = await this.track.readFrame();
          if (!frame) {
            this.close(new Error("MoQ screenshot track closed before frame arrived"));
            return;
          }
          this.dispatch(frame);
          if (this.closed) return;
        }
      } catch (err) {
        this.close(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }

  private dispatch(frame: Uint8Array): void {
    let payload: { id?: unknown; data?: unknown };
    try {
      payload = JSON.parse(new TextDecoder().decode(frame)) as { id?: unknown; data?: unknown };
    } catch {
      this.failOldest(new Error("MoQ screenshot frame was not valid JSON"));
      return;
    }

    if (typeof payload.data !== "string") {
      this.failOldest(
        new Error(`MoQ screenshot frame missing 'data' field: ${JSON.stringify(payload)}`),
      );
      return;
    }

    const bytes = base64ToBytes(payload.data);
    const id = typeof payload.id === "string" ? payload.id : undefined;
    const index = id === undefined ? 0 : this.pending.findIndex((p) => p.id === id);
    if (index === -1) {
      // A response nobody is waiting for — a duplicate, or the leftover answer
      // to a request that already failed. Dropping it is the only safe move.
      return;
    }
    this.pending.splice(index, 1)[0]?.resolve(bytes);
  }

  private settle(id: string, error: Error): void {
    const index = this.pending.findIndex((p) => p.id === id);
    if (index !== -1) this.pending.splice(index, 1)[0]?.reject(error);
  }

  private failOldest(error: Error): void {
    this.pending.shift()?.reject(error);
  }
}

function base64ToBytes(base64: string): Uint8Array {
  // `atob` exists in browsers and in Node 16+, so this needs no environment
  // branch and no Buffer (which would drag Node types into browser bundles).
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
