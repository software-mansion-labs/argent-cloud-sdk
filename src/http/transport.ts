import { ApiError, MoqDirectUnavailableError, SimctlError } from "./errors.js";

/**
 * How a request reaches the control plane. Two shapes exist today:
 *
 *  - `makeBearerTransport` — straight at sim-router, carrying a session token.
 *    Used by headless clients and any browser that holds its own credentials.
 *  - `makeProxyTransport` — at a local server that already holds the session
 *    (the webui's Rust binary). Same paths and payloads, no Authorization
 *    header, because the proxy adds it.
 *
 * `SimulatorApi` is written against this interface, so both callers share one
 * implementation of every endpoint.
 */
export interface HttpTransport {
  request(path: string, init?: RequestInit): Promise<Response>;
}

export interface TransportOptions {
  /** Defaults to `globalThis.fetch`. Supply one for tests or a custom agent. */
  fetch?: typeof fetch;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

function makeTransport(
  baseUrl: string,
  options: TransportOptions & { authorization?: () => string | undefined | Promise<string | undefined> },
): HttpTransport {
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch) {
    throw new Error("No fetch implementation available; pass one via options.fetch");
  }
  return {
    async request(path, init) {
      const headers = new Headers(init?.headers);
      const auth = await options.authorization?.();
      if (auth && !headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${auth}`);
      }
      return doFetch(joinUrl(baseUrl, path), { ...init, headers });
    },
  };
}

/**
 * Talks to sim-router directly. `token` may be a plain string or a callback, so
 * a client that re-logs-in can hand over a fresh token without rebuilding the
 * transport.
 */
export function makeBearerTransport(
  baseUrl: string,
  token: string | (() => string | undefined | Promise<string | undefined>),
  options: TransportOptions = {},
): HttpTransport {
  return makeTransport(baseUrl, {
    ...options,
    authorization: typeof token === "function" ? token : () => token,
  });
}

/** Talks to a local proxy that owns the session (the webui's `/api`). */
export function makeProxyTransport(baseUrl: string, options: TransportOptions = {}): HttpTransport {
  return makeTransport(baseUrl, options);
}

/** Decode a base64 string from the wire into its bytes. */
function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Throws for a failed response: `SimctlError` when the body carries a simctl
 * run, `MoqDirectUnavailableError` for the routine 409 on the direct
 * endpoints, `ApiError` otherwise.
 */
export async function throwForStatus(response: Response, path: string): Promise<never> {
  let message = response.statusText || `HTTP ${response.status}`;
  let code: string | undefined;
  let command: string | undefined;
  let simctl: { exit_code?: unknown; stdout?: unknown; stderr?: unknown } | undefined;
  try {
    const body = (await response.json()) as {
      error?: unknown;
      code?: unknown;
      command?: unknown;
      simctl?: unknown;
    };
    if (typeof body.error === "string") message = body.error;
    if (typeof body.code === "string") code = body.code;
    if (typeof body.command === "string") command = body.command;
    if (body.simctl && typeof body.simctl === "object") {
      simctl = body.simctl as typeof simctl;
    }
  } catch {
    // Not every error body is JSON — fall back to the status text.
  }
  // Since protocol v2 a simctl that ran and refused carries its exit code and
  // both streams (base64) beside the message, so a caller standing in for
  // `xcrun simctl` can reproduce them.
  if (simctl && typeof simctl.exit_code === "number") {
    throw new SimctlError(response.status, message, {
      code,
      command,
      exitCode: simctl.exit_code,
      stdout: typeof simctl.stdout === "string" ? fromBase64(simctl.stdout) : new Uint8Array(0),
      stderr: typeof simctl.stderr === "string" ? fromBase64(simctl.stderr) : new Uint8Array(0),
    });
  }
  if (response.status === 409 && /\/(moq\/direct|direct)$/.test(path)) {
    throw new MoqDirectUnavailableError(response.status, message, code);
  }
  throw new ApiError(response.status, message, code);
}

/**
 * Performs a request and returns the raw `Response`, for the endpoints whose
 * body is a live stream (`POST /builds`) or whose headers carry part of the
 * answer. Still throws for a non-2xx status.
 */
export async function requestRaw(
  transport: HttpTransport,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await transport.request(path, init);
  if (!response.ok) await throwForStatus(response, path);
  return response;
}

/** Performs a request and parses a JSON body; returns `undefined` for an empty one. */
export async function requestJson<T>(
  transport: HttpTransport,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await transport.request(path, init);
  if (!response.ok) await throwForStatus(response, path);
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Performs a request and returns the raw body — screenshots, recordings, spawn streams. */
export async function requestBytes(
  transport: HttpTransport,
  path: string,
  init?: RequestInit,
): Promise<Uint8Array> {
  const response = await transport.request(path, init);
  if (!response.ok) await throwForStatus(response, path);
  return new Uint8Array(await response.arrayBuffer());
}

/** Performs a request and discards a successful body. */
export async function requestVoid(
  transport: HttpTransport,
  path: string,
  init?: RequestInit,
): Promise<void> {
  const response = await transport.request(path, init);
  if (!response.ok) await throwForStatus(response, path);
}

/** Shorthand for a JSON-bodied POST. */
export function jsonBody(value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}
