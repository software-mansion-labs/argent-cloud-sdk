import type {
  AcquireResult,
  DirectEndpoint,
  InjectDylibOptions,
  LaunchOptions,
  MachinesResult,
  MoqInfo,
  RecordStartOptions,
  Simulator,
  SpawnOptions,
} from "../types.js";
import {
  jsonBody,
  requestBytes,
  requestJson,
  requestVoid,
  type HttpTransport,
} from "./transport.js";

/**
 * Every device and session operation sim-router exposes.
 *
 * The webui's Rust proxy mirrors these paths and payloads under `/api`, so the
 * same class drives both — the difference lives entirely in the transport. The
 * session methods (`acquire`, `attach`, `machines`, `release`, `heartbeat`,
 * `direct`) only exist on the router itself; a proxy that owns the session
 * handles those on its own and its callers never reach for them here.
 */
export class SimulatorApi {
  constructor(private readonly transport: HttpTransport) {}

  // ── Session ────────────────────────────────────────────────────────────────

  /**
   * Claim a machine. `timeoutSecs` is how long the router may block waiting for
   * a free one — omitted or 0 fails fast. The router clamps it to its own max.
   */
  acquire(timeoutSecs?: number): Promise<AcquireResult> {
    const query = timeoutSecs ? `?timeout_secs=${timeoutSecs}` : "";
    return requestJson(this.transport, `/acquire${query}`, { method: "POST" });
  }

  /** Re-attach to a machine this session already holds. */
  attach(machineId: string): Promise<AcquireResult> {
    return requestJson(this.transport, `/attach?machine_id=${encodeURIComponent(machineId)}`, {
      method: "POST",
    });
  }

  machines(): Promise<MachinesResult> {
    return requestJson(this.transport, "/machines");
  }

  release(): Promise<void> {
    return requestVoid(this.transport, "/release", { method: "POST" });
  }

  heartbeat(): Promise<void> {
    return requestVoid(this.transport, "/session/heartbeat", { method: "POST" });
  }

  /**
   * The orchestrator's own relay-less endpoint.
   * Throws `MoqDirectUnavailableError` (409) when the machine isn't reachable
   * directly, which means the caller should stay on the relay.
   */
  direct(): Promise<DirectEndpoint> {
    return requestJson(this.transport, "/direct");
  }

  // ── Devices ────────────────────────────────────────────────────────────────

  listSimulators(): Promise<Simulator[]> {
    return requestJson(this.transport, "/simulators");
  }

  boot(udid: string): Promise<void> {
    return requestVoid(this.transport, `${devicePath(udid)}/boot`, { method: "POST" });
  }

  shutdown(udid: string): Promise<void> {
    return requestVoid(this.transport, `${devicePath(udid)}/shutdown`, { method: "POST" });
  }

  /** Returns the raw image bytes. */
  screenshot(udid: string): Promise<Uint8Array> {
    return requestBytes(this.transport, `${devicePath(udid)}/screenshot`, { method: "POST" });
  }

  recordStart(udid: string, options: RecordStartOptions = {}): Promise<void> {
    return requestVoid(this.transport, `${devicePath(udid)}/record/start`, jsonBody(options));
  }

  /** Returns the recorded video bytes. */
  recordStop(udid: string): Promise<Uint8Array> {
    return requestBytes(this.transport, `${devicePath(udid)}/record/stop`, { method: "POST" });
  }

  /** Coordinates are normalized to 0..1. */
  tap(udid: string, x: number, y: number): Promise<void> {
    return requestVoid(this.transport, `${devicePath(udid)}/tap`, jsonBody({ x, y }));
  }

  launch(udid: string, options: LaunchOptions): Promise<Uint8Array> {
    return requestBytes(
      this.transport,
      `${devicePath(udid)}/launch`,
      jsonBody({ app_id: options.app_id, args: options.args ?? [] }),
    );
  }

  /** Uploads a `.app`/`.ipa` archive. */
  install(udid: string, archive: Uint8Array): Promise<void> {
    const form = new FormData();
    form.append("archive", new Blob([toArrayBuffer(archive)]), "app.zip");
    return requestVoid(this.transport, `${devicePath(udid)}/install`, {
      method: "POST",
      body: form,
    });
  }

  /**
   * `simctl spawn`. Without `binary`, `args` is the full in-simulator argv;
   * with it, the binary is uploaded first and `args` are its arguments.
   * Returns the spawn stream (`application/x-sim-spawn-stream`) or, when
   * detached, an empty body.
   */
  spawn(udid: string, options: SpawnOptions = {}): Promise<Uint8Array> {
    const form = new FormData();
    form.append(
      "descriptor",
      JSON.stringify({ args: options.args ?? [], detach: options.detach ?? false }),
    );
    if (options.binary) {
      form.append("binary", new Blob([toArrayBuffer(options.binary)]), "binary");
    }
    return requestBytes(this.transport, `${devicePath(udid)}/spawn`, {
      method: "POST",
      body: form,
    });
  }

  injectDylib(udid: string, options: InjectDylibOptions): Promise<void> {
    const form = new FormData();
    form.append(
      "descriptor",
      JSON.stringify({ filename: options.filename, insert: options.insert ?? false }),
    );
    form.append("binary", new Blob([toArrayBuffer(options.binary)]), options.filename);
    return requestVoid(this.transport, `${devicePath(udid)}/dylibs`, {
      method: "POST",
      body: form,
    });
  }

  removeDylib(udid: string, filename: string): Promise<void> {
    return requestVoid(
      this.transport,
      `${devicePath(udid)}/dylibs/${encodeURIComponent(filename)}`,
      { method: "DELETE" },
    );
  }

  setEnv(udid: string, key: string, value: string): Promise<void> {
    return requestVoid(this.transport, `${devicePath(udid)}/env`, jsonBody({ key, value }));
  }

  /** Writes text to the simulator's pasteboard. The body is the raw text. */
  pbcopy(udid: string, text: string): Promise<void> {
    return requestVoid(this.transport, `${devicePath(udid)}/pbcopy`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: text,
    });
  }

  /** Runs an arbitrary `simctl` command; returns its raw output. */
  simctl(args: string[]): Promise<Uint8Array> {
    return requestBytes(this.transport, "/simctl", jsonBody({ args }));
  }

  // ── Streaming endpoints ────────────────────────────────────────────────────

  /** MoQ endpoint via the router's relay. Always reachable. */
  moqInfo(udid: string): Promise<MoqInfo> {
    return requestJson(this.transport, `${devicePath(udid)}/moq`);
  }

  /**
   * MoQ endpoint straight at the Mac. Throws `MoqDirectUnavailableError` (409)
   * when the machine has no public host — fall back to `moqInfo`, or let
   * `openWithDirectFallback` do it for you.
   */
  moqDirectInfo(udid: string): Promise<MoqInfo> {
    return requestJson(this.transport, `${devicePath(udid)}/moq/direct`);
  }

  webrtcOffer<T = unknown>(udid: string, offer: unknown): Promise<T> {
    return requestJson(this.transport, `${devicePath(udid)}/webrtc/offer`, jsonBody(offer));
  }
}

function devicePath(udid: string): string {
  return `/simulators/${encodeURIComponent(udid)}`;
}

/** `Blob` needs a real ArrayBuffer; a typed array may be a view into a larger one. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
