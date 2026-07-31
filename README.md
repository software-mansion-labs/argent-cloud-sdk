# @swmansion/sim-client

Client library for the sim-orchestrator stack. It covers the two things every
client needs — the control plane (sim-router's HTTP API) and the device plane
(MoQ video, input and screenshots) — so headless and interactive clients share
one implementation instead of each keeping its own copy.

Used by the radon-cloud webui and by argent.

## Install

```bash
npm install @swmansion/sim-client @moq/net
```

`@moq/watch` is needed only for video rendering, and `ws` +
`@fails-components/webtransport` only under Node. All three are optional peers.

## Control plane

`SimulatorApi` speaks sim-router's HTTP API. How a request is authenticated is
the transport's business, so the same class works whether you hold a session
token yourself or sit behind a proxy that holds one for you:

```ts
import { RouterAuthClient, SimulatorApi, makeBearerTransport } from "@swmansion/sim-client";

const auth = new RouterAuthClient(makeBearerTransport(routerUrl, undefined));
const { token } = await auth.login(username, apiKey);

const api = new SimulatorApi(makeBearerTransport(routerUrl, token));
await api.acquire(60);
const devices = await api.listSimulators();
```

Behind a session-owning proxy — the webui's Rust binary, say — swap in
`makeProxyTransport("/api")` and skip the auth and session calls entirely.

Failures throw `ApiError` carrying the router's stable `code`; use `isRetryable`
to spot a `machine_unavailable` you can wait out.

## Device plane

```ts
import { MoqDeviceSession, openWithDirectFallback, createDirectFallbackState } from "@swmansion/sim-client";

const fallback = createDirectFallbackState();
const connection = await openWithDirectFallback({
  getDirect: () => api.moqDirectInfo(udid),
  getRelay: () => api.moqInfo(udid),
  state: fallback,
});

const session = new MoqDeviceSession(connection);
await session.touch("Down", 0.5, 0.5);
await session.touch("Up", 0.5, 0.5);
const png = await session.screenshot();
```

`openWithDirectFallback` prefers the relay-less endpoint and drops to the relay
if it isn't reachable. Share one `DirectFallbackState` across reconnects to the
same device so a dead direct route is only discovered once.

Reconnect policy is deliberately yours: watch `session.closed` and open a new
session when it settles.

### Video (browser)

```ts
import { attachVideo } from "@swmansion/sim-client/video";

const video = attachVideo(session.connection, canvas, {
  onResize: () => relayoutOverlay(),
});
// later: video.close()
```

### Node

There is no WebTransport in Node, so install the polyfill globals once before
the first connect:

```ts
import { installNodeWebTransport } from "@swmansion/sim-client/node";

await installNodeWebTransport();
```

## The input protocol

Input is protobuf `DataChannelCommand` on the MoQ `control` track. The encoder
in `src/proto/encoder.ts` is written by hand rather than generated, so the
browser bundle carries no protobuf runtime. `proto/datachannel.proto` is the
canonical schema, and `test/encoder.test.ts` checks every encoder branch against
protobufjs parsing that file — if the schema and the encoder drift apart, the
test fails.

When simulator-server's schema changes, update both together.

## Developing against an unpublished build

The webui depends on this package by path, so its dev loop needs nothing extra.
For argent, which depends on the published version, build a tarball and install
it:

```bash
npm run build && npm pack
```

Then in the argent checkout:

```bash
npm install /path/to/radon-cloud/packages/sim-client/swmansion-sim-client-0.1.0.tgz
```
