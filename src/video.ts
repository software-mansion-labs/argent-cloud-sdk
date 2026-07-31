/**
 * Browser-only video rendering, kept out of the main entry so Node consumers
 * never load `@moq/watch` (which needs WebCodecs and the DOM).
 *
 * Import from `@swmansion/sim-client/video`.
 */
import { Path, type Connection } from "@moq/net";
import { Broadcast as WatchBroadcast, Sync, Video, type Latency } from "@moq/watch";

import { SERVER_BROADCAST } from "./moq/session.js";

export interface AttachVideoOptions {
  /** Called after the canvas is resized to a new stream resolution. */
  onResize?: (size: { width: number; height: number }) => void;
  /** Playback latency target. Defaults to "real-time" for interactive use. */
  latency?: Latency;
}

export interface VideoAttachment {
  close(): void;
}

/**
 * Decodes the device's video track into `canvas`, resizing it whenever the
 * stream resolution changes. Call `close()` before tearing down the session.
 */
export function attachVideo(
  connection: Connection.Established,
  canvas: HTMLCanvasElement,
  options: AttachVideoOptions = {},
): VideoAttachment {
  const broadcast = new WatchBroadcast({
    connection,
    name: Path.from(SERVER_BROADCAST),
    catalogFormat: "hang",
    enabled: true,
  });

  const sync = new Sync({ latency: options.latency ?? "real-time" });
  const source = new Video.Source(sync, { broadcast });
  const decoder = new Video.Decoder(source, { enabled: true });
  const renderer = new Video.Renderer(decoder, { canvas });

  let width = 0;
  let height = 0;
  const stopWatching = decoder.display.changed((display) => {
    if (!display) return;
    if (display.width === width && display.height === height) return;
    width = display.width;
    height = display.height;
    canvas.width = width;
    canvas.height = height;
    options.onResize?.({ width, height });
  });

  return {
    close() {
      stopWatching?.();
      renderer.close();
      decoder.close();
      source.close();
      sync.close();
      broadcast.close();
    },
  };
}
