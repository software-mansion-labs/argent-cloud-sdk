import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import { describe, expect, it } from "vitest";

import {
  encodeButton,
  encodeInput,
  encodeKey,
  encodeRotate,
  encodeScreenshot,
  encodeTouch,
  encodeTouchState,
  encodeWheel,
  type InputMessage,
} from "../src/proto/encoder.js";

/**
 * The hand-rolled encoder is only trustworthy if it agrees with a real protobuf
 * implementation reading the canonical schema. Every case below is encoded both
 * ways and compared byte-for-byte.
 */
const protoPath = fileURLToPath(new URL("../proto/datachannel.proto", import.meta.url));
const root = protobuf.parse(readFileSync(protoPath, "utf8"), { keepCase: false }).root;
const DataChannelCommand = root.lookupType("datachannel.DataChannelCommand");

function reference(payload: Record<string, unknown>): Uint8Array {
  return DataChannelCommand.encode(DataChannelCommand.create(payload)).finish();
}

function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(Array.from(actual)).toEqual(Array.from(expected));
}

describe("touch", () => {
  it.each([
    ["Down at origin (every field at its default)", { action: "Down" as const, x: 0, y: 0 }, 0],
    ["Down mid-screen", { action: "Down" as const, x: 0.5, y: 0.25 }, 0],
    ["Up", { action: "Up" as const, x: 1, y: 1 }, 1],
    ["Move", { action: "Move" as const, x: 0.123456789, y: 0.987654321 }, 2],
  ])("%s", (_name, opts, action) => {
    expectSameBytes(encodeTouch(opts), reference({ touch: { action, x: opts.x, y: opts.y } }));
  });

  it("includes both optional second-finger coordinates", () => {
    expectSameBytes(
      encodeTouch({ action: "Move", x: 0.2, y: 0.3, secondX: 0.7, secondY: 0.8 }),
      reference({ touch: { action: 2, x: 0.2, y: 0.3, secondX: 0.7, secondY: 0.8 } }),
    );
  });

  it("includes a second coordinate of zero when explicitly given", () => {
    // `second_x` is `optional`, so 0 is a present value, not an omitted default.
    expectSameBytes(
      encodeTouch({ action: "Down", x: 0.1, y: 0.1, secondX: 0, secondY: 0 }),
      reference({ touch: { action: 0, x: 0.1, y: 0.1, secondX: 0, secondY: 0 } }),
    );
  });

  it("omits a second coordinate that is undefined", () => {
    expectSameBytes(
      encodeTouch({ action: "Down", x: 0.1, y: 0.1, secondX: undefined }),
      reference({ touch: { action: 0, x: 0.1, y: 0.1 } }),
    );
  });
});

describe("touchState", () => {
  it("encodes an empty snapshot (all pointers lifted)", () => {
    expectSameBytes(encodeTouchState([]), reference({ touchState: {} }));
  });

  it("encodes a single pointer, including explicit zero values", () => {
    expectSameBytes(
      encodeTouchState([{ id: 0, x: 0, y: 0 }]),
      reference({ touchState: { pointers: [{ id: 0, x: 0, y: 0 }] } }),
    );
  });

  it("encodes multiple pointers in order", () => {
    const pointers = [
      { id: 1, x: 0.25, y: 0.75 },
      { id: 2, x: 0.5, y: 0.5 },
      { id: 7, x: 1, y: 0 },
    ];
    expectSameBytes(encodeTouchState(pointers), reference({ touchState: { pointers } }));
  });

  it("sign-extends a negative pointer id", () => {
    expectSameBytes(
      encodeTouchState([{ id: -1, x: 0.1, y: 0.2 }]),
      reference({ touchState: { pointers: [{ id: -1, x: 0.1, y: 0.2 }] } }),
    );
  });
});

describe("key", () => {
  it.each([
    ["Down, code 0", { action: "Down" as const, code: 0 }, 0],
    ["Down, small code", { action: "Down" as const, code: 4 }, 0],
    ["Up, multi-byte varint code", { action: "Up" as const, code: 300 }, 1],
    ["Up, large code", { action: "Up" as const, code: 0x7fffffff }, 1],
  ])("%s", (_name, opts, action) => {
    expectSameBytes(encodeKey(opts), reference({ key: { action, code: opts.code } }));
  });

  it("sign-extends a negative int32 to ten bytes", () => {
    expectSameBytes(encodeKey({ action: "Down", code: -1 }), reference({ key: { action: 0, code: -1 } }));
  });
});

describe("button", () => {
  const buttons = ["home", "back", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"] as const;

  it.each(buttons.map((b, i) => [b, i] as const))("%s down and up", (button, value) => {
    expectSameBytes(encodeButton({ action: "Down", button }), reference({ button: { action: 0, button: value } }));
    expectSameBytes(encodeButton({ action: "Up", button }), reference({ button: { action: 1, button: value } }));
  });
});

describe("rotate", () => {
  const rotations = ["Portrait", "PortraitUpsideDown", "LandscapeLeft", "LandscapeRight"] as const;

  it.each(rotations.map((r, i) => [r, i] as const))("%s", (direction, value) => {
    expectSameBytes(encodeRotate(direction), reference({ rotate: { direction: value } }));
  });
});

describe("wheel", () => {
  it.each([
    ["all zero", { x: 0, y: 0, dx: 0, dy: 0 }],
    ["scroll down", { x: 0.5, y: 0.5, dx: 0, dy: -1 }],
    ["diagonal fractional", { x: 0.25, y: 0.75, dx: 12.5, dy: -3.25 }],
  ])("%s", (_name, opts) => {
    expectSameBytes(encodeWheel(opts), reference({ wheel: opts }));
  });
});

describe("screenshot", () => {
  it("encodes an empty command", () => {
    expectSameBytes(encodeScreenshot(), reference({ screenshot: {} }));
    expectSameBytes(encodeScreenshot({}), reference({ screenshot: {} }));
  });

  it("encodes an id", () => {
    expectSameBytes(encodeScreenshot({ id: "42" }), reference({ screenshot: { id: "42" } }));
  });

  it("encodes a non-ASCII id using its UTF-8 length", () => {
    expectSameBytes(encodeScreenshot({ id: "zażółć-🦀" }), reference({ screenshot: { id: "zażółć-🦀" } }));
  });

  it("encodes an empty-string id as present", () => {
    expectSameBytes(encodeScreenshot({ id: "" }), reference({ screenshot: { id: "" } }));
  });

  it.each([
    ["exactly representable", 0.5],
    ["needs f32 rounding", 0.3],
    ["one", 1],
    ["zero", 0],
    ["repeating fraction", 1 / 3],
  ])("encodes a float scale (%s)", (_name, scale) => {
    expectSameBytes(encodeScreenshot({ scale }), reference({ screenshot: { scale } }));
  });

  it("encodes every field together", () => {
    expectSameBytes(
      encodeScreenshot({ id: "7", rotation: "LandscapeLeft", scale: 0.3, downscaler: "nearest" }),
      reference({ screenshot: { id: "7", rotation: 2, scale: 0.3, downscaler: 3 } }),
    );
  });

  it.each([
    ["lanczos3", 0],
    ["box", 1],
    ["bilinear", 2],
    ["nearest", 3],
  ] as const)("encodes downscaler %s", (downscaler, value) => {
    expectSameBytes(encodeScreenshot({ downscaler }), reference({ screenshot: { downscaler: value } }));
  });
});

describe("encodeInput", () => {
  it.each([
    [{ type: "touch", action: "Move", x: 0.4, y: 0.6 }, encodeTouch({ action: "Move", x: 0.4, y: 0.6 })],
    [{ type: "key", action: "Up", code: 40 }, encodeKey({ action: "Up", code: 40 })],
    [{ type: "button", action: "Down", button: "home" }, encodeButton({ action: "Down", button: "home" })],
    [{ type: "rotate", direction: "LandscapeRight" }, encodeRotate("LandscapeRight")],
    [{ type: "wheel", x: 0.1, y: 0.2, dx: 1, dy: 2 }, encodeWheel({ x: 0.1, y: 0.2, dx: 1, dy: 2 })],
    [{ type: "screenshot", id: "9" }, encodeScreenshot({ id: "9" })],
  ] as [InputMessage, Uint8Array][])("dispatches %o", (msg, expected) => {
    expectSameBytes(encodeInput(msg), expected);
  });
});
