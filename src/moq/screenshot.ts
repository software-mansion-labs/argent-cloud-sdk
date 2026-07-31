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

/**
 * Request/response channel layered over the MoQ control and "screenshot"
 * tracks: the request goes out as a `ScreenshotCommand` carrying an id, and the
 * server echoes that id back on the shared screenshot track alongside the
 * base64 image.
 *
 * Responses are matched by id, so concurrent callers can't steal each other's
 * frames. A server too old to echo the id still works — an id-less frame is
 * handed to the oldest waiter, which is correct because the server answers in
 * the order it receives requests.
 */
export class ScreenshotChannel {
  private readonly pending: Pending[] = [];
  private nextId = 0;
  private reading = false;
  private closed = false;

  constructor(
    private readonly track: Track,
    private readonly sendControl: (payload: Uint8Array) => Promise<void>,
  ) {}

  request(options: ScreenshotOptions = {}): Promise<Uint8Array> {
    if (this.closed) {
      return Promise.reject(new Error("MoQ screenshot channel is closed"));
    }

    const id = String(++this.nextId);
    const result = new Promise<Uint8Array>((resolve, reject) => {
      this.pending.push({ id, resolve, reject });
    });

    this.startReading();

    this.sendControl(encodeScreenshot({ ...options, id })).catch((err: unknown) => {
      this.settle(id, err instanceof Error ? err : new Error(String(err)));
    });

    return result;
  }

  /** Fails every in-flight request; call when the session goes away. */
  close(reason?: Error): void {
    this.closed = true;
    const error = reason ?? new Error("MoQ screenshot channel is closed");
    while (this.pending.length > 0) {
      this.pending.shift()?.reject(error);
    }
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
