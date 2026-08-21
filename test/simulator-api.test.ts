import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  MoqDirectUnavailableError,
  ProtocolVersionMismatchError,
  SimctlError,
} from "../src/http/errors.js";
import { RouterAuthClient, assertProtocolVersion } from "../src/http/router-client.js";
import { PROTOCOL_VERSION } from "../src/types.js";
import { SimulatorApi } from "../src/http/simulator-api.js";
import { makeBearerTransport, makeProxyTransport } from "../src/http/transport.js";

type Call = { url: string; init: RequestInit | undefined };

function stubFetch(response: () => Response) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function empty(status = 200): Response {
  return new Response(null, { status });
}

describe("transport", () => {
  it("adds a bearer header and joins the base url", async () => {
    const { calls, fetchImpl } = stubFetch(() => json([]));
    const api = new SimulatorApi(
      makeBearerTransport("https://router.example/", "sess-token", { fetch: fetchImpl }),
    );

    await api.listSimulators();

    expect(calls[0]?.url).toBe("https://router.example/simulators");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer sess-token");
  });

  it("resolves a token callback per request", async () => {
    const tokens = ["first", "second"];
    const { calls, fetchImpl } = stubFetch(() => json([]));
    const api = new SimulatorApi(
      makeBearerTransport("https://router.example", () => tokens.shift(), { fetch: fetchImpl }),
    );

    await api.listSimulators();
    await api.listSimulators();

    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer first");
    expect(new Headers(calls[1]?.init?.headers).get("Authorization")).toBe("Bearer second");
  });

  it("sends no Authorization header through a proxy transport", async () => {
    const { calls, fetchImpl } = stubFetch(() => json([]));
    const api = new SimulatorApi(makeProxyTransport("/api", { fetch: fetchImpl }));

    await api.listSimulators();

    expect(calls[0]?.url).toBe("/api/simulators");
    expect(new Headers(calls[0]?.init?.headers).has("Authorization")).toBe(false);
  });
});

describe("errors", () => {
  it("surfaces the error message and code", async () => {
    const { fetchImpl } = stubFetch(() =>
      json({ error: "no machine available", code: "machine_unavailable" }, 503),
    );
    const api = new SimulatorApi(makeProxyTransport("/api", { fetch: fetchImpl }));

    await expect(api.acquire()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      message: "no machine available",
      code: "machine_unavailable",
    });
  });

  it("falls back to the status text for a non-JSON body", async () => {
    const { fetchImpl } = stubFetch(() => new Response("gateway blew up", { status: 502 }));
    const api = new SimulatorApi(makeProxyTransport("/api", { fetch: fetchImpl }));

    const error = await api.listSimulators().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it("raises MoqDirectUnavailableError for a 409 on the direct endpoints", async () => {
    const { fetchImpl } = stubFetch(() => json({ error: "machine has no public host" }, 409));
    const api = new SimulatorApi(makeProxyTransport("/api", { fetch: fetchImpl }));

    await expect(api.moqDirectInfo("UDID")).rejects.toBeInstanceOf(MoqDirectUnavailableError);
    await expect(api.direct()).rejects.toBeInstanceOf(MoqDirectUnavailableError);
  });

  it("raises SimctlError carrying the exit code and raw streams", async () => {
    const { fetchImpl } = stubFetch(() =>
      json(
        {
          error: "Invalid device: NOPE",
          code: "simctl",
          command: "boot",
          simctl: {
            exit_code: 164,
            stdout: "",
            // "boom\n" — bytes, not text: base64 on the wire.
            stderr: "Ym9vbQo=",
          },
        },
        400,
      ),
    );
    const api = new SimulatorApi(makeProxyTransport("/api", { fetch: fetchImpl }));

    const error = await api.boot("NOPE").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SimctlError);
    const simctl = error as SimctlError;
    expect(simctl.status).toBe(400);
    expect(simctl.code).toBe("simctl");
    expect(simctl.command).toBe("boot");
    expect(simctl.exitCode).toBe(164);
    expect(new TextDecoder().decode(simctl.stderr)).toBe("boom\n");
    expect(simctl.stdout).toHaveLength(0);
  });

  it("keeps a plain ApiError for a 409 elsewhere", async () => {
    const { fetchImpl } = stubFetch(() => json({ error: "already recording" }, 409));
    const api = new SimulatorApi(makeProxyTransport("/api", { fetch: fetchImpl }));

    const error = await api.recordStart("UDID").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(MoqDirectUnavailableError);
  });
});

describe("endpoints", () => {
  let calls: Call[];
  let api: SimulatorApi;

  beforeEach(() => {
    const stub = stubFetch(() => json({}));
    calls = stub.calls;
    api = new SimulatorApi(makeProxyTransport("/api", { fetch: stub.fetchImpl }));
  });

  const last = () => calls[calls.length - 1];

  it("acquires without a timeout by default and with one when asked", async () => {
    await api.acquire();
    expect(last()?.url).toBe("/api/acquire");
    await api.acquire(60);
    expect(last()?.url).toBe("/api/acquire?timeout_secs=60");
  });

  it("url-encodes the udid and the machine id", async () => {
    await api.boot("a/b c");
    expect(last()?.url).toBe("/api/simulators/a%2Fb%20c/boot");
    await api.attach("machine/1");
    expect(last()?.url).toBe("/api/attach?machine_id=machine%2F1");
  });

  it("posts tap coordinates", async () => {
    await api.tap("UDID", 0.5, 0.25);
    expect(last()?.url).toBe("/api/simulators/UDID/tap");
    expect(last()?.init?.method).toBe("POST");
    expect(JSON.parse(String(last()?.init?.body))).toEqual({ x: 0.5, y: 0.25 });
  });

  it("names the install part `app`, which the router checks", async () => {
    await api.install("UDID", new Uint8Array([1, 2, 3]));
    const form = last()?.init?.body as FormData;
    expect(form.get("app")).toBeInstanceOf(Blob);
    expect(form.get("archive")).toBeNull();
  });

  it("posts env pairs and simctl args", async () => {
    await api.setEnv("UDID", "KEY", "value");
    expect(JSON.parse(String(last()?.init?.body))).toEqual({ key: "KEY", value: "value" });
    await api.simctl(["list", "devices"]);
    expect(last()?.url).toBe("/api/simctl");
    expect(JSON.parse(String(last()?.init?.body))).toEqual({ args: ["list", "devices"] });
  });

  it("sends the staged simctl descriptor and tar", async () => {
    await api.simctlStaged({
      args: ["addmedia", "UDID", "/tmp/a.png"],
      staged: [2],
      files: new Uint8Array([1]),
    });
    expect(last()?.url).toBe("/api/simctl/staged");
    const form = last()?.init?.body as FormData;
    expect(JSON.parse(String(form.get("descriptor")))).toEqual({
      args: ["addmedia", "UDID", "/tmp/a.png"],
      staged: [2],
    });
    expect(form.get("files")).toBeInstanceOf(Blob);
  });

  it("queries the app container by bundle id", async () => {
    await api.appContainer("UDID", { bundle_id: "com.example.app" });
    expect(last()?.url).toBe("/api/simulators/UDID/app-container?bundle_id=com.example.app");
    await api.appContainer("UDID", { bundle_id: "com.example.app", container: "data" });
    expect(last()?.url).toBe(
      "/api/simulators/UDID/app-container?bundle_id=com.example.app&container=data",
    );
  });

  it("reads the plain-QUIC relay endpoint", async () => {
    await api.quicInfo("UDID");
    expect(last()?.url).toBe("/api/simulators/UDID/quic");
  });

  it("sends the spawn descriptor as multipart", async () => {
    await api.spawn("UDID", { args: ["--flag"], detach: true });
    const form = last()?.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(JSON.parse(String(form.get("descriptor")))).toEqual({ args: ["--flag"], detach: true });
    expect(form.get("binary")).toBeNull();
  });

  it("attaches the binary part when spawning an uploaded binary", async () => {
    await api.spawn("UDID", { binary: new Uint8Array([1, 2, 3]) });
    const form = last()?.init?.body as FormData;
    expect(form.get("binary")).toBeInstanceOf(Blob);
  });

  it("sends the dylib descriptor and binary", async () => {
    await api.injectDylib("UDID", { filename: "lib.dylib", insert: true, binary: new Uint8Array([1]) });
    const form = last()?.init?.body as FormData;
    expect(JSON.parse(String(form.get("descriptor")))).toEqual({
      filename: "lib.dylib",
      insert: true,
    });
    expect(last()?.url).toBe("/api/simulators/UDID/dylibs");
  });

  it("deletes a dylib by name", async () => {
    await api.removeDylib("UDID", "lib.dylib");
    expect(last()?.url).toBe("/api/simulators/UDID/dylibs/lib.dylib");
    expect(last()?.init?.method).toBe("DELETE");
  });

  it("sends pasteboard text as the raw body", async () => {
    await api.pbcopy("UDID", "hello");
    expect(last()?.init?.body).toBe("hello");
  });
});

describe("binary responses", () => {
  it("returns screenshot bytes", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { fetchImpl } = stubFetch(() => new Response(png));
    const api = new SimulatorApi(makeProxyTransport("/api", { fetch: fetchImpl }));

    expect(Array.from(await api.screenshot("UDID"))).toEqual(Array.from(png));
  });
});

describe("empty responses", () => {
  it("resolves void endpoints with no body", async () => {
    const { fetchImpl } = stubFetch(() => empty(200));
    const api = new SimulatorApi(makeProxyTransport("/api", { fetch: fetchImpl }));

    await expect(api.release()).resolves.toBeUndefined();
    await expect(api.heartbeat()).resolves.toBeUndefined();
  });
});

describe("RouterAuthClient", () => {
  it("posts credentials with snake_case keys", async () => {
    const { calls, fetchImpl } = stubFetch(() => json({ token: "t", protocol_version: 1 }));
    const auth = new RouterAuthClient(
      makeProxyTransport("https://router.example", { fetch: fetchImpl }),
    );

    await expect(auth.login("user", "key")).resolves.toEqual({ token: "t", protocol_version: 1 });
    expect(calls[0]?.url).toBe("https://router.example/auth/login");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ username: "user", api_key: "key" });
  });

  it("reads the unauthenticated version probe", async () => {
    const { calls, fetchImpl } = stubFetch(() => json({ protocol_version: 3 }));
    const auth = new RouterAuthClient(
      makeProxyTransport("https://router.example", { fetch: fetchImpl }),
    );

    await expect(auth.version()).resolves.toEqual({ protocol_version: 3 });
    expect(calls[0]?.url).toBe("https://router.example/version");
  });

  it("accepts a router on this build's protocol and rejects any other", async () => {
    expect(() => assertProtocolVersion(PROTOCOL_VERSION)).not.toThrow();
    expect(() => assertProtocolVersion(PROTOCOL_VERSION - 1)).toThrow(
      ProtocolVersionMismatchError,
    );
  });

  it("asserts the probed version", async () => {
    const { fetchImpl } = stubFetch(() => json({ protocol_version: PROTOCOL_VERSION + 1 }));
    const auth = new RouterAuthClient(
      makeProxyTransport("https://router.example", { fetch: fetchImpl }),
    );

    const error = await auth.assertProtocolVersion().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolVersionMismatchError);
    expect((error as ProtocolVersionMismatchError).actual).toBe(PROTOCOL_VERSION + 1);
    expect((error as ProtocolVersionMismatchError).expected).toBe(PROTOCOL_VERSION);
  });
});
