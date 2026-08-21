import { PROTOCOL_VERSION, type LoginResult } from "../types.js";
import { ProtocolVersionMismatchError } from "./errors.js";
import { jsonBody, requestJson, requestVoid, type HttpTransport } from "./transport.js";

/**
 * The router's authentication endpoints. Separate from `SimulatorApi` because a
 * client behind a session-owning proxy (the webui) never calls these — its
 * proxy logs in on its behalf.
 *
 * `login` is unauthenticated, so build its transport without a token and use
 * the returned one for everything after.
 */
export class RouterAuthClient {
  constructor(private readonly transport: HttpTransport) {}

  login(username: string, apiKey: string): Promise<LoginResult> {
    return requestJson(this.transport, "/auth/login", jsonBody({ username, api_key: apiKey }));
  }

  logout(): Promise<void> {
    return requestVoid(this.transport, "/auth/logout", { method: "POST" });
  }

  /**
   * Unauthenticated version probe. Compare against `PROTOCOL_VERSION` to detect
   * a router deploy that outdated this client, or let `assertProtocolVersion`
   * do it.
   */
  version(): Promise<{ protocol_version: number }> {
    return requestJson(this.transport, "/version");
  }

  /**
   * Probe `/version` and throw `ProtocolVersionMismatchError` unless the router
   * speaks exactly `PROTOCOL_VERSION`.
   *
   * Worth doing before anything else: a version gap is not a degraded mode but
   * a silent-wrong-answer one. A v1 client against a v2 router reads a failed
   * `simctl` as an empty success.
   */
  async assertProtocolVersion(): Promise<void> {
    const { protocol_version: actual } = await this.version();
    assertProtocolVersion(actual);
  }
}

/**
 * Throw unless `actual` is the protocol this build speaks. Use it on the
 * `protocol_version` a login reply already carries, to avoid a second probe.
 */
export function assertProtocolVersion(actual: number): void {
  if (actual !== PROTOCOL_VERSION) {
    throw new ProtocolVersionMismatchError(PROTOCOL_VERSION, actual);
  }
}
