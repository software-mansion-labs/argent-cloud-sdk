/**
 * Client library for the sim-orchestrator stack.
 *
 * Two layers, usable independently:
 *
 *  - **Control plane** — `SimulatorApi` / `RouterAuthClient` over an
 *    `HttpTransport`, covering sim-router's HTTP API. Point it at the router
 *    with `makeBearerTransport`, or at a proxy that owns the session with
 *    `makeProxyTransport`.
 *  - **Device plane** — `MoqDeviceSession` for streaming and input over MoQ.
 *
 * Video rendering lives in `@swmansion/sim-client/video` (browser only) and the
 * Node WebTransport polyfill in `@swmansion/sim-client/node`, so neither leaks
 * into environments that can't use it.
 */

export * from "./types.js";

export { ApiError, MoqDirectUnavailableError, isRetryable } from "./http/errors.js";
export {
  makeBearerTransport,
  makeProxyTransport,
  type HttpTransport,
  type TransportOptions,
} from "./http/transport.js";
export { RouterAuthClient } from "./http/router-client.js";
export { SimulatorApi } from "./http/simulator-api.js";

export {
  encodeButton,
  encodeInput,
  encodeKey,
  encodeRotate,
  encodeScreenshot,
  encodeTouch,
  encodeWheel,
  type ButtonName,
  type DownscalerName,
  type InputMessage,
  type KeyActionName,
  type RotationName,
  type TouchActionName,
} from "./proto/encoder.js";

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
  MoqDeviceSession,
  SERVER_BROADCAST,
  type MoqDeviceSessionOptions,
} from "./moq/session.js";
export { ScreenshotChannel, type ScreenshotOptions } from "./moq/screenshot.js";
