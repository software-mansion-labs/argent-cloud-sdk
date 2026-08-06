import { Connection } from "@moq/net";

import type { MoqInfo } from "../types.js";
import { decodeHexFingerprint } from "./fingerprint.js";

export interface ConnectOptions {
  /**
   * Passed through to WebTransport. The certificate pin is always set from
   * `info.fingerprint`; these are merged on top for callers that want to tune
   * congestion control or pooling.
   */
  webtransport?: Omit<WebTransportOptions, "serverCertificateHashes">;
}

/**
 * Opens a MoQ session to the simulator-server described by `info`.
 *
 * In Node, call `installNodeWebTransport()` from `@swmansion/argent-cloud-sdk/node`
 * first — there is no built-in WebTransport there.
 */
export async function connectMoq(info: MoqInfo, options: ConnectOptions = {}) {
  const url = new URL(info.url);
  // sim-server rejects sessions without the lease token; the relay forwards it
  // end-to-end from the `?token=` query param.
  if (info.token) url.searchParams.set("token", info.token);
  const fingerprint = decodeHexFingerprint(info.fingerprint);

  try {
    return await Connection.connect(url, {
      webtransport: {
        ...options.webtransport,
        serverCertificateHashes: [{ algorithm: "sha-256", value: fingerprint }],
      },
      // The WebSocket fallback is pointless against simulator-server (QUIC
      // only), and racing it costs the default head-start delay on every
      // reconnect.
      websocket: { enabled: false },
    });
  } catch (err) {
    throw unwrapMoqConnectError(err, info.url);
  }
}

/**
 * `connect()` races WebTransport against WebSocket with `Promise.any`, so a
 * failure surfaces as an `AggregateError` whose message is the useless "All
 * promises were rejected". Pull out the real causes — cert pin mismatch,
 * handshake timeout, missing polyfill.
 */
export function unwrapMoqConnectError(err: unknown, url: string): Error {
  if (err instanceof AggregateError) {
    const parts = err.errors.map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
    return new Error(`MoQ connect to ${url} failed: ${parts.join(" | ")}`);
  }
  if (err instanceof Error) {
    return new Error(`MoQ connect to ${url} failed: ${err.message}`);
  }
  return new Error(`MoQ connect to ${url} failed: ${String(err)}`);
}
