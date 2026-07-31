import type { Connection } from "@moq/net";

import type { MoqInfo } from "../types.js";
import { connectMoq, type ConnectOptions } from "./connect.js";

/**
 * Remembers that the direct endpoint proved unreachable, so later attempts go
 * straight to the relay instead of paying the direct timeout every time.
 *
 * Hold one of these for as long as you'd keep retrying the same device, and
 * drop it when you move to a different one.
 */
export interface DirectFallbackState {
  directDead: boolean;
}

export function createDirectFallbackState(): DirectFallbackState {
  return { directDead: false };
}

export interface DirectFallbackOptions extends ConnectOptions {
  /** Fetches the relay-less endpoint; rejects (409) when there isn't one. */
  getDirect: () => Promise<MoqInfo>;
  /** Fetches the relayed endpoint. Always expected to work. */
  getRelay: () => Promise<MoqInfo>;
  state?: DirectFallbackState;
  /** Called when direct fails, before falling back. */
  onFallback?: (error: unknown) => void;
}

/**
 * Connects to the device, preferring the relay-less endpoint.
 *
 * Falls back to the relay if either the direct lookup or the direct connect
 * fails — the Mac's MoQ port can be unreachable even when the router reports a
 * direct URL — and sticks with the relay from then on.
 */
export async function openWithDirectFallback(
  options: DirectFallbackOptions,
): Promise<Connection.Established> {
  const { getDirect, getRelay, state, onFallback, ...connectOptions } = options;

  if (!state?.directDead) {
    try {
      return await connectMoq(await getDirect(), connectOptions);
    } catch (err) {
      if (state) state.directDead = true;
      onFallback?.(err);
    }
  }

  return connectMoq(await getRelay(), connectOptions);
}
