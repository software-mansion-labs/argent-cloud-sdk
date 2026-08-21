/**
 * Client library for the Argent Cloud device backend.
 *
 * Two layers, usable independently:
 *
 *  - **Control plane** — `SimulatorApi` / `RouterAuthClient` over an
 *    `HttpTransport`, covering sim-router's HTTP API. Point it at the router
 *    with `makeBearerTransport`, or at a proxy that owns the session with
 *    `makeProxyTransport`.
 *  - **Device plane** — `MoqDeviceSession` for streaming and input over MoQ.
 *  - **Build plane** — `BuildsApi` for remote `xcodebuild` runs and their
 *    artifacts. Needs no acquired machine.
 *
 * The control plane speaks router protocol `PROTOCOL_VERSION`; check a peer
 * with `assertProtocolVersion` before using it.
 *
 * Video rendering lives in `@swmansion/argent-cloud-sdk/video` (browser only) and the
 * Node WebTransport polyfill in `@swmansion/argent-cloud-sdk/node`, so neither leaks
 * into environments that can't use it.
 */

export * from "./types.js";

export {
  ApiError,
  MoqDirectUnavailableError,
  ProtocolVersionMismatchError,
  SimctlError,
  isRetryable,
} from "./http/errors.js";
export {
  makeBearerTransport,
  makeProxyTransport,
  type HttpTransport,
  type TransportOptions,
} from "./http/transport.js";
export { RouterAuthClient, assertProtocolVersion } from "./http/router-client.js";
export { SimulatorApi } from "./http/simulator-api.js";
export { BuildsApi, type SubmittedBuild } from "./http/builds-api.js";

export {
  SPAWN_STREAM_CONTENT_TYPE,
  MAX_SPAWN_FRAME_BYTES,
  SpawnFrameDecoder,
  SpawnFrameError,
  decodeSpawnStream,
  type SpawnExit,
  type SpawnFrame,
  type SpawnResult,
} from "./proto/spawn-stream.js";
export {
  BUILD_ID_HEADER,
  BUILD_STREAM_CONTENT_TYPE,
  MAX_BUILD_FRAME_BYTES,
  BuildFrameDecoder,
  BuildFrameError,
  decodeBuildStream,
  type BuildFrame,
} from "./proto/build-stream.js";

export {
  encodeButton,
  encodeInput,
  encodeKey,
  encodeRotate,
  encodeScreenshot,
  encodeTouch,
  encodeTouchState,
  encodeWheel,
  type ButtonName,
  type DownscalerName,
  type InputMessage,
  type KeyActionName,
  type RotationName,
  type TouchActionName,
  type TouchPointer,
} from "./proto/encoder.js";
export { diffTouchStates } from "./proto/touch-state.js";

export { connectMoq, unwrapMoqConnectError, type ConnectOptions } from "./moq/connect.js";
export { decodeHexFingerprint } from "./moq/fingerprint.js";
export {
  createDirectFallbackState,
  openWithDirectFallback,
  type DirectFallbackOptions,
  type DirectFallbackState,
} from "./moq/fallback.js";
export {
  CONTROL_TRACK,
  KEYS_TRACK,
  MoqDeviceSession,
  SERVER_BROADCAST,
  TOUCH_TRACK,
  type MoqDeviceSessionOptions,
} from "./moq/session.js";
export { ScreenshotChannel, type ScreenshotOptions } from "./moq/screenshot.js";
