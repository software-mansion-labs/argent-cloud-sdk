/**
 * `@fails-components/webtransport` is an optional peer that only Node consumers
 * install, and its `exports` map offers no condition a bundler-mode resolver can
 * see. Declaring the narrow surface `src/node.ts` uses keeps this package
 * type-checkable without it, and without asserting anything about the rest of
 * its API.
 */
declare module "@fails-components/webtransport" {
  export const WebTransport: unknown;
  /** Resolves once the bundled libquiche binding has loaded. */
  export const quicheLoaded: Promise<unknown>;
}
