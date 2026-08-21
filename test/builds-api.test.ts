import { describe, expect, it, vi } from "vitest";

import { BuildsApi } from "../src/http/builds-api.js";
import { makeProxyTransport } from "../src/http/transport.js";
import { BuildFrameDecoder, BuildFrameError } from "../src/proto/build-stream.js";
import type { BuildDescriptor, BuildResult } from "../src/types.js";

function frame(tag: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = tag;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);
const logFrame = (s: string) => frame(0, text(s));
const resultFrame = (r: BuildResult) => frame(2, text(JSON.stringify(r)));

const DESCRIPTOR: BuildDescriptor = {
  scheme: "MyApp",
  configuration: "Debug",
  project: { kind: "workspace", path: "MyApp.xcworkspace" },
  steps: [{ kind: "pods" }, { kind: "xcodebuild" }],
  timeout_seconds: 1800,
};

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("BuildsApi.submit", () => {
  it("sends the descriptor first, then the source archive", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return new Response(streamOf(logFrame("compiling\n")), {
        status: 202,
        headers: { "x-build-id": "build-1" },
      });
    }) as unknown as typeof fetch;
    const builds = new BuildsApi(makeProxyTransport("/api", { fetch: fetchImpl }));

    const { buildId } = await builds.submit(DESCRIPTOR, new Uint8Array([1, 2, 3]));

    expect(buildId).toBe("build-1");
    const form = seen?.body as FormData;
    // The router rejects a body whose parts arrive in the other order.
    expect([...form.keys()]).toEqual(["descriptor", "source"]);
    expect(JSON.parse(String(form.get("descriptor")))).toEqual({ descriptor: DESCRIPTOR });
    expect(form.get("source")).toBeInstanceOf(Blob);
  });

  it("streams log frames and ends on the result frame", async () => {
    const result: BuildResult = { kind: "success", artifact_path: "Build/MyApp.app" };
    const fetchImpl = (async () =>
      new Response(streamOf(logFrame("step 1\n"), logFrame("step 2\n"), resultFrame(result)), {
        status: 202,
        headers: { "x-build-id": "build-2" },
      })) as unknown as typeof fetch;
    const builds = new BuildsApi(makeProxyTransport("/api", { fetch: fetchImpl }));

    const { frames } = await builds.submit(DESCRIPTOR, new Uint8Array());
    const collected = [];
    for await (const f of frames) collected.push(f);

    expect(collected).toEqual([
      { kind: "stdout", bytes: text("step 1\n") },
      { kind: "stdout", bytes: text("step 2\n") },
      { kind: "result", result },
    ]);
  });

  it("refuses a submit whose response carried no build id", async () => {
    const fetchImpl = (async () =>
      new Response(streamOf(), { status: 202 })) as unknown as typeof fetch;
    const builds = new BuildsApi(makeProxyTransport("/api", { fetch: fetchImpl }));

    await expect(builds.submit(DESCRIPTOR, new Uint8Array())).rejects.toThrow(/x-build-id/);
  });
});

describe("BuildsApi endpoints", () => {
  const stub = (response: () => Response) => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return response();
    }) as unknown as typeof fetch;
    return { calls, builds: new BuildsApi(makeProxyTransport("/api", { fetch: fetchImpl })) };
  };

  it("reads a build's status", async () => {
    const body = { build_id: "b1", status: "running", result: null };
    const { calls, builds } = stub(() => Response.json(body));

    await expect(builds.status("b1")).resolves.toEqual(body);
    expect(calls[0]?.url).toBe("/api/builds/b1");
  });

  it("url-encodes the build id everywhere", async () => {
    const { calls, builds } = stub(() => Response.json({}));

    await builds.cancel("a/b");
    await builds.installBuilt("a/b", "UDID");
    expect(calls[0]?.url).toBe("/api/builds/a%2Fb/cancel");
    expect(calls[1]?.url).toBe("/api/builds/a%2Fb/install");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ udid: "UDID" });
  });

  it("returns artifact bytes", async () => {
    const tarball = new Uint8Array([0x1f, 0x8b]);
    const { calls, builds } = stub(() => new Response(tarball));

    expect(Array.from(await builds.artifact("b1"))).toEqual(Array.from(tarball));
    expect(calls[0]?.url).toBe("/api/builds/b1/artifact");
  });
});

describe("BuildFrameDecoder", () => {
  it("throws on a malformed result payload", () => {
    const decoder = new BuildFrameDecoder();
    decoder.push(frame(2, text("not json")));
    expect(() => decoder.pop()).toThrow(BuildFrameError);
  });
});
