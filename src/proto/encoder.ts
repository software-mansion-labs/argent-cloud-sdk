/**
 * Encoder for `datachannel.DataChannelCommand`, the protobuf message
 * simulator-server reads off the MoQ "control" track.
 *
 * Written by hand rather than through protobufjs: the schema is six encode-only
 * messages, and a runtime parser would cost ~70 KB in the browser bundle for no
 * benefit. `test/encoder.test.ts` checks every branch byte-for-byte against
 * protobufjs parsing `proto/datachannel.proto`, so drift fails the build.
 */

export type TouchActionName = "Down" | "Up" | "Move";
export type KeyActionName = "Down" | "Up";
export type ButtonName =
  | "home"
  | "back"
  | "power"
  | "volumeUp"
  | "volumeDown"
  | "appSwitch"
  | "actionButton";
export type RotationName = "Portrait" | "PortraitUpsideDown" | "LandscapeLeft" | "LandscapeRight";
export type DownscalerName = "lanczos3" | "box" | "bilinear" | "nearest";

const TOUCH_ACTION: Record<TouchActionName, number> = { Down: 0, Up: 1, Move: 2 };
const KEY_ACTION: Record<KeyActionName, number> = { Down: 0, Up: 1 };
const BUTTON_TYPE: Record<ButtonName, number> = {
  home: 0,
  back: 1,
  power: 2,
  volumeUp: 3,
  volumeDown: 4,
  appSwitch: 5,
  actionButton: 6,
};
const ROTATION: Record<RotationName, number> = {
  Portrait: 0,
  PortraitUpsideDown: 1,
  LandscapeLeft: 2,
  LandscapeRight: 3,
};
const DOWNSCALER: Record<DownscalerName, number> = {
  lanczos3: 0,
  box: 1,
  bilinear: 2,
  nearest: 3,
};

const WIRE_VARINT = 0;
const WIRE_F64 = 1;
const WIRE_LEN = 2;
const WIRE_F32 = 5;

const f64View = new DataView(new ArrayBuffer(8));
const f32View = new DataView(new ArrayBuffer(4));

function varint(out: number[], value: number): void {
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
}

function tag(out: number[], field: number, wire: number): void {
  varint(out, (field << 3) | wire);
}

function double(out: number[], field: number, value: number): void {
  tag(out, field, WIRE_F64);
  f64View.setFloat64(0, value, true);
  for (let i = 0; i < 8; i++) out.push(f64View.getUint8(i));
}

function float(out: number[], field: number, value: number): void {
  tag(out, field, WIRE_F32);
  f32View.setFloat32(0, value, true);
  for (let i = 0; i < 4; i++) out.push(f32View.getUint8(i));
}

function enumField(out: number[], field: number, value: number): void {
  tag(out, field, WIRE_VARINT);
  varint(out, value);
}

/**
 * proto3 `int32` is encoded as a 10-byte varint when negative — it is
 * sign-extended to 64 bits rather than zig-zagged. HID key codes are always
 * positive, but encode it correctly so the parity test can cover the range.
 */
function int32(out: number[], field: number, value: number): void {
  tag(out, field, WIRE_VARINT);
  if (value >= 0) {
    varint(out, value);
    return;
  }
  let v = BigInt.asUintN(64, BigInt(value));
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
}

function stringField(out: number[], field: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  tag(out, field, WIRE_LEN);
  varint(out, bytes.length);
  for (const b of bytes) out.push(b);
}

/** Wraps an encoded sub-message as the given `oneof` field of DataChannelCommand. */
function wrap(field: number, inner: number[]): Uint8Array {
  const out: number[] = [];
  tag(out, field, WIRE_LEN);
  varint(out, inner.length);
  return new Uint8Array([...out, ...inner]);
}

// Fields the caller supplies are always written, even at their proto3 default.
// Emitting them is redundant on the wire but harmless to prost, and it keeps
// these bytes identical to what the previous protobufjs-based encoder produced.

export function encodeTouch(opts: {
  action: TouchActionName;
  x: number;
  y: number;
  secondX?: number;
  secondY?: number;
}): Uint8Array {
  const inner: number[] = [];
  enumField(inner, 1, TOUCH_ACTION[opts.action]);
  double(inner, 2, opts.x);
  double(inner, 3, opts.y);
  if (opts.secondX !== undefined && opts.secondX !== null) double(inner, 4, opts.secondX);
  if (opts.secondY !== undefined && opts.secondY !== null) double(inner, 5, opts.secondY);
  return wrap(1, inner);
}

export function encodeKey(opts: { action: KeyActionName; code: number }): Uint8Array {
  const inner: number[] = [];
  enumField(inner, 1, KEY_ACTION[opts.action]);
  int32(inner, 2, opts.code);
  return wrap(2, inner);
}

export function encodeButton(opts: { action: KeyActionName; button: ButtonName }): Uint8Array {
  const inner: number[] = [];
  enumField(inner, 1, KEY_ACTION[opts.action]);
  enumField(inner, 2, BUTTON_TYPE[opts.button]);
  return wrap(3, inner);
}

export function encodeRotate(direction: RotationName): Uint8Array {
  const inner: number[] = [];
  enumField(inner, 1, ROTATION[direction]);
  return wrap(4, inner);
}

export function encodeWheel(opts: { x: number; y: number; dx: number; dy: number }): Uint8Array {
  const inner: number[] = [];
  double(inner, 1, opts.x);
  double(inner, 2, opts.y);
  double(inner, 3, opts.dx);
  double(inner, 4, opts.dy);
  return wrap(5, inner);
}

export function encodeScreenshot(opts?: {
  id?: string;
  rotation?: RotationName;
  scale?: number;
  downscaler?: DownscalerName;
}): Uint8Array {
  const inner: number[] = [];
  // Every ScreenshotCommand field is `optional`, so presence is explicit and a
  // zero value still goes on the wire.
  if (opts?.id !== undefined) stringField(inner, 1, opts.id);
  if (opts?.rotation !== undefined) enumField(inner, 2, ROTATION[opts.rotation]);
  if (opts?.scale !== undefined) float(inner, 3, opts.scale);
  if (opts?.downscaler !== undefined) enumField(inner, 4, DOWNSCALER[opts.downscaler]);
  return wrap(6, inner);
}

/**
 * Tagged-union form of the same commands, for callers that carry input events
 * around as data (the webui's pointer/keyboard handlers) instead of calling the
 * per-command encoders directly.
 */
export type InputMessage =
  | { type: "touch"; action: TouchActionName; x: number; y: number; secondX?: number; secondY?: number }
  | { type: "key"; action: KeyActionName; code: number }
  | { type: "button"; action: KeyActionName; button: ButtonName }
  | { type: "rotate"; direction: RotationName }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "screenshot"; id?: string; rotation?: RotationName; scale?: number; downscaler?: DownscalerName };

export function encodeInput(msg: InputMessage): Uint8Array {
  switch (msg.type) {
    case "touch":
      return encodeTouch(msg);
    case "key":
      return encodeKey(msg);
    case "button":
      return encodeButton(msg);
    case "rotate":
      return encodeRotate(msg.direction);
    case "wheel":
      return encodeWheel(msg);
    case "screenshot":
      return encodeScreenshot(msg);
  }
}
