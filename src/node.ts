/**
 * Node support, kept out of the main entry so browser bundles never see `ws` or
 * the WebTransport polyfill.
 *
 * Import from `@swmansion/sim-client/node`.
 */

let ready: Promise<void> | null = null;

/**
 * Installs WebTransport (and WebSocket) globals so `connectMoq` works under
 * Node. Call it once before the first connect; repeat calls reuse the same
 * initialization.
 *
 * Requires the optional `@fails-components/webtransport` and `ws` peers.
 */
export function installNodeWebTransport(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const globals = globalThis as Record<string, unknown>;
    if (typeof globals.WebSocket === "undefined") {
      const ws = await import("ws");
      globals.WebSocket = ws.default;
    }
    if (typeof globals.WebTransport === "undefined") {
      const wt = await import("@fails-components/webtransport");
      globals.WebTransport = wt.WebTransport;
      // One-shot promise resolving once the bundled libquiche binding loads.
      await wt.quicheLoaded;
    }
  })();
  return ready;
}
