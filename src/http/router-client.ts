import type { LoginResult } from "../types.js";
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
   * Unauthenticated version probe. Compare against the `protocol_version` the
   * client was built for to detect a router deploy that outdated it.
   */
  version(): Promise<{ protocol_version: number }> {
    return requestJson(this.transport, "/version");
  }
}
