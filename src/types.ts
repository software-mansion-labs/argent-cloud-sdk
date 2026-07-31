/**
 * Wire types shared with the Rust side. These mirror `sim-types` (the source of
 * truth) and the serde shapes of sim-router's HTTP handlers; keep them in sync
 * by hand — there is no codegen.
 */

/** Mirrors `sim_types::SimulatorState` (serde `snake_case`). */
export type SimulatorState =
  | "booted"
  | "shutdown"
  | "booting"
  | "shutting_down"
  | "creating"
  | "unknown";

/** Mirrors `sim_types::Simulator`. */
export interface Simulator {
  udid: string;
  name: string;
  state: SimulatorState;
  runtime: string;
  available: boolean;
  device_type: string;
}

/**
 * Everything needed to open a MoQ session against a device.
 *
 * `token` is the session's orchestrator token. It must be sent as `?token=` on
 * the connect URL — simulator-server rejects sessions without it, whether they
 * arrive directly or through the relay.
 */
export interface MoqInfo {
  url: string;
  fingerprint: string;
  token: string;
}

/** `POST /auth/login` response. */
export interface LoginResult {
  token: string;
  /** The router's `PROTOCOL_VERSION`; a mismatch means the client is outdated. */
  protocol_version: number;
}

/** `POST /acquire` and `POST /attach` response. */
export interface AcquireResult {
  orchestrator_token: string;
  machine_id: string;
}

export interface MachineRow {
  machine_id: string;
  is_current: boolean;
}

/** `GET /machines` response. */
export interface MachinesResult {
  machines: MachineRow[];
}

/** `GET /direct` response: the orchestrator's own relay-less endpoint. */
export interface DirectEndpoint {
  url: string;
  orchestrator_token: string;
}

/** Optional `simctl recordVideo` options; omit for simctl defaults. */
export interface RecordStartOptions {
  codec?: string;
  display?: string;
  mask?: string;
}

export interface LaunchOptions {
  app_id: string;
  args?: string[];
}

export interface SpawnOptions {
  args?: string[];
  detach?: boolean;
  /** Local binary to upload and run inside the simulator. */
  binary?: Uint8Array;
}

export interface InjectDylibOptions {
  filename: string;
  /** Add the dylib to `DYLD_INSERT_LIBRARIES` as well as uploading it. */
  insert?: boolean;
  binary: Uint8Array;
}
