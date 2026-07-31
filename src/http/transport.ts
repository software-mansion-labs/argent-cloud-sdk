import { ApiError, MoqDirectUnavailableError } from "./errors.js";

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

/** Throws an `ApiError` (or `MoqDirectUnavailableError` on 409) for a failed response. */
export async function throwForStatus(response: Response, path: string): Promise<never> {
  let message = response.statusText || `HTTP ${response.status}`;
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string") message = body.error;
    if (typeof body.code === "string") code = body.code;
  } catch {
    // Not every error body is JSON — fall back to the status text.
  }
  if (response.status === 409 && /\/(moq\/direct|direct)$/.test(path)) {
    throw new MoqDirectUnavailableError(response.status, message, code);
  }
  throw new ApiError(response.status, message, code);
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
