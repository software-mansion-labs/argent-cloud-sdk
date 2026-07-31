import { describe, expect, it, vi } from "vitest";

import { unwrapMoqConnectError } from "../src/moq/connect.js";
import { createDirectFallbackState, openWithDirectFallback } from "../src/moq/fallback.js";
import { decodeHexFingerprint } from "../src/moq/fingerprint.js";
import type { MoqInfo } from "../src/types.js";

vi.mock("@moq/net", () => ({
  Connection: {
    connect: vi.fn(async (url: URL) => ({ url }) as never),
  },
}));

const { Connection } = await import("@moq/net");
const connect = Connection.connect as unknown as ReturnType<typeof vi.fn>;

const direct: MoqInfo = { url: "https://mac.example:8443", fingerprint: "aabb", token: "tok" };
const relay: MoqInfo = { url: "https://router.example/relay/xyz", fingerprint: "ccdd", token: "tok" };

describe("decodeHexFingerprint", () => {
  it("accepts bare hex", () => {
    expect(Array.from(decodeHexFingerprint("aabbcc"))).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it("accepts colon-separated and mixed-case hex", () => {
    expect(Array.from(decodeHexFingerprint("AA:bB:Cc"))).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it("rejects an odd number of hex digits", () => {
    expect(() => decodeHexFingerprint("abc")).toThrow(/odd hex length/);
  });

  it("rejects a string with no hex digits", () => {
    expect(() => decodeHexFingerprint("::::")).toThrow(/no hex digits/);
  });
});

describe("unwrapMoqConnectError", () => {
  it("spells out every cause of an AggregateError", () => {
    const error = unwrapMoqConnectError(
      new AggregateError([new TypeError("cert mismatch"), new Error("timeout")]),
      "https://mac.example",
    );
    expect(error.message).toContain("TypeError: cert mismatch");
    expect(error.message).toContain("Error: timeout");
    expect(error.message).toContain("https://mac.example");
  });

  it("keeps the message of a plain error", () => {
    expect(unwrapMoqConnectError(new Error("boom"), "url").message).toContain("boom");
  });

  it("stringifies a non-error rejection", () => {
    expect(unwrapMoqConnectError("nope", "url").message).toContain("nope");
  });
});

describe("openWithDirectFallback", () => {
  it("prefers the direct endpoint", async () => {
    connect.mockClear();
    await openWithDirectFallback({
      getDirect: async () => direct,
      getRelay: async () => relay,
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(String(connect.mock.calls[0]?.[0])).toContain("mac.example");
  });

  it("appends the auth token to the connect url", async () => {
    connect.mockClear();
    await openWithDirectFallback({ getDirect: async () => direct, getRelay: async () => relay });

    expect((connect.mock.calls[0]?.[0] as URL).searchParams.get("token")).toBe("tok");
  });

  it("falls back to the relay when the direct lookup fails", async () => {
    connect.mockClear();
    const onFallback = vi.fn();
    await openWithDirectFallback({
      getDirect: async () => {
        throw new Error("409");
      },
      getRelay: async () => relay,
      onFallback,
    });

    expect(onFallback).toHaveBeenCalledOnce();
    expect(String(connect.mock.calls[0]?.[0])).toContain("router.example");
  });

  it("falls back to the relay when the direct connect fails", async () => {
    connect.mockClear();
    connect.mockRejectedValueOnce(new Error("unreachable"));

    await openWithDirectFallback({ getDirect: async () => direct, getRelay: async () => relay });

    expect(connect).toHaveBeenCalledTimes(2);
    expect(String(connect.mock.calls[1]?.[0])).toContain("router.example");
  });

  it("stops retrying direct once it has failed with shared state", async () => {
    connect.mockClear();
    const state = createDirectFallbackState();
    const getDirect = vi.fn(async () => {
      throw new Error("409");
    });

    await openWithDirectFallback({ getDirect, getRelay: async () => relay, state });
    await openWithDirectFallback({ getDirect, getRelay: async () => relay, state });

    expect(getDirect).toHaveBeenCalledOnce();
    expect(state.directDead).toBe(true);
  });

  it("keeps trying direct when no state is shared", async () => {
    connect.mockClear();
    const getDirect = vi.fn(async () => {
      throw new Error("409");
    });

    await openWithDirectFallback({ getDirect, getRelay: async () => relay });
    await openWithDirectFallback({ getDirect, getRelay: async () => relay });

    expect(getDirect).toHaveBeenCalledTimes(2);
  });

  it("propagates a relay failure", async () => {
    connect.mockClear();
    await expect(
      openWithDirectFallback({
        getDirect: async () => {
          throw new Error("no direct");
        },
        getRelay: async () => {
          throw new Error("relay down");
        },
      }),
    ).rejects.toThrow("relay down");
  });
});
