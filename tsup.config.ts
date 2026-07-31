import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    video: "src/video.ts",
    node: "src/node.ts",
  },
  // Dual output so argent's CommonJS tool-server can require the core and node
  // entries. `video` is browser-only and only ever exposed as ESM in `exports`.
  format: ["esm", "cjs"],
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  splitting: false,
  // Peers are supplied by the consumer. The two Node-only ones are dynamically
  // imported and may not be installed at all, so esbuild must not try to
  // resolve them at build time.
  external: ["@moq/net", "@moq/watch", "@fails-components/webtransport", "ws"],
});
