# @swmansion/argent-cloud-sdk

Client library for Argent Cloud. It covers the two things every
client needs — the control plane (router's HTTP API) and the device plane
(MoQ video, input and screenshots) — so headless and interactive clients share
one implementation instead of each keeping its own copy. Remote builds live
alongside them in `BuildsApi`.

The control plane tracks a versioned wire protocol; this release speaks
`PROTOCOL_VERSION` 2.

Used by the Argent Cloud webui and by the `@swmansion/argent` package.

## Install

```bash
npm install @swmansion/argent-cloud-sdk @moq/net
```

`@moq/watch` is needed only for video rendering, and `ws` +
`@fails-components/webtransport` only under Node. All three are optional peers.

## Control plane

`SimulatorApi` speaks router's HTTP API. How a request is authenticated is
the transport's business, so the same class works whether you hold a session
token yourself or sit behind a proxy that holds one for you:

```ts
import {
  RouterAuthClient,
  SimulatorApi,
  makeBearerTransport,
} from "@swmansion/argent-cloud-sdk";

const auth = new RouterAuthClient(makeBearerTransport(routerUrl, undefined));
const { token } = await auth.login(username, apiKey);

const api = new SimulatorApi(makeBearerTransport(routerUrl, token));
await api.acquire(60);
const devices = await api.listSimulators();
```

Behind a session-owning proxy — the webui's Rust binary, say — swap in
`makeProxyTransport("/api")` and skip the auth and session calls entirely.

Failures throw `ApiError` carrying the router's stable `code`; use `isRetryable`
to spot a `machine_unavailable` you can wait out. A `simctl` that ran and
refused throws `SimctlError` instead, carrying its exit code and both raw
output streams.

### Protocol version

The router's protocol is versioned, and a mismatch is a hard break rather than
a degraded mode — so check it before issuing anything else:

```ts
await auth.assertProtocolVersion();          // probes GET /version
// or, from a login reply you already have:
assertProtocolVersion(loginResult.protocol_version);
```

### Running simctl

`simctl` and `spawn` answer with a frame stream, so stdout and stderr stay
separate and the exit status comes back with them. A non-zero exit is a
*successful* call — the command ran and said no:

```ts
const { stdout, exit } = await api.simctl(["list", "devices", "--json"]);
if (exit?.code !== 0) throw new Error("simctl refused");
const devices = JSON.parse(new TextDecoder().decode(stdout));
```

Subcommands that name local files (`addmedia`, `install_app_data`, `keychain
add-cert`) need those files uploaded with them — `simctlStaged` takes a tar of
them plus the argv indices they occupy. Building the tar is yours; the SDK
ships no tar writer.

## Builds

`BuildsApi` submits a project tarball for a remote `xcodebuild` run. The submit
response *is* the log stream, and the build id arrives with the headers, so
status and cancellation are available while logs are still arriving:

```ts
import { BuildsApi } from "@swmansion/argent-cloud-sdk";

const builds = new BuildsApi(makeBearerTransport(routerUrl, token));
const { buildId, frames } = await builds.submit(descriptor, sourceTarGz);

for await (const frame of frames) {
  if (frame.kind === "result") console.log(frame.result);
  else process.stdout.write(frame.bytes);
}

await builds.installBuilt(buildId, udid);
```

## Device plane

```ts
import {
  MoqDeviceSession,
  openWithDirectFallback,
  createDirectFallbackState,
} from "@swmansion/argent-cloud-sdk";

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
import { attachVideo } from "@swmansion/argent-cloud-sdk/video";

const video = attachVideo(session.connection, canvas, {
  onResize: () => relayoutOverlay(),
});
// later: video.close()
```

### Node

There is no WebTransport in Node, so install the polyfill globals once before
the first connect:

```ts
import { installNodeWebTransport } from "@swmansion/argent-cloud-sdk/node";

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
npm install /path/to/argent-cloud-sdk/swmansion-argent-cloud-sdk-<version>.tgz
```
