/**
 * Wire types shared with the Rust side. These mirror `sim-types` (the source of
 * truth) and the serde shapes of sim-router's HTTP handlers; keep them in sync
 * by hand — there is no codegen.
 */

/**
 * The router protocol this build speaks, mirroring `sim_types::PROTOCOL_VERSION`.
 *
 * A mismatch against `/version` (or the `protocol_version` in a login reply) is
 * a hard break, not a warning: v2 changed `/simctl` from a plain body to a
 * frame stream and made a failed simctl a *successful* operation carrying its
 * exit code, so a v1 client reads a v2 failure as an empty success. Check it
 * with `assertProtocolVersion` before issuing anything else.
 */
export const PROTOCOL_VERSION = 2;

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

/**
 * `POST /simulators/{udid}/app-container` arguments: `simctl
 * get_app_container`'s parameters past the device.
 *
 * The reply is a `.tar.gz` of the container *directories*, not the paths
 * simctl prints — a path on the runner names nothing the caller can open. A
 * `.sim-remote-containers.json` manifest (`AppContainers`) rides inside it,
 * naming what each entry is.
 */
export interface AppContainerOptions {
  bundle_id: string;
  /** `app` (the default), `data`, `groups`, or one group identifier. */
  container?: string;
}

/** Mirrors `sim_types::protocol::AppContainers`, the archive's manifest. */
export interface AppContainers {
  containers: AppContainer[];
}

export interface AppContainer {
  /** The App Group identifier simctl labelled this with; `null` for a bare path. */
  label: string | null;
  /** The archive entry holding it: the container directory's own name. */
  entry: string;
}

/** Name of the manifest at the root of an app-container archive. */
export const APP_CONTAINER_MANIFEST = ".sim-remote-containers.json";

/**
 * `POST /simctl/staged` arguments: a `simctl` passthrough whose file arguments
 * are uploaded alongside it.
 *
 * `files` is a tar archive of the named files, each under a directory named
 * for its index in `args`; `staged` lists those indices. The orchestrator
 * extracts them into scratch and rewrites the argv to the extracted paths
 * before running the ordinary passthrough. Building the tar is the caller's
 * job — this SDK ships no tar writer.
 */
export interface SimctlStagedOptions {
  args: string[];
  /** Indices into `args` that name a staged file. */
  staged: number[];
  files: Uint8Array;
}

/** `GET /simulators/{udid}/quic` response: the router's plain-QUIC relay. */
export interface QuicInfo {
  url: string;
  fingerprint: string;
}

// ── Builds ───────────────────────────────────────────────────────────────────

/** Mirrors `sim_types::build_protocol::Configuration`. */
export type Configuration = "Debug" | "Release";

/**
 * Whether the project root holds a `.xcworkspace` (`-workspace`) or only a
 * `.xcodeproj` (`-project`). Paths are relative to the archive root.
 */
export type ProjectRef =
  | { kind: "workspace"; path: string }
  | { kind: "project"; path: string };

/**
 * One pipeline step run in the worker's workspace after source extraction.
 * Exactly one must be `xcodebuild`; steps after it run post-build.
 */
export type BuildStep =
  | { kind: "run"; command: string }
  | { kind: "pods" }
  | { kind: "xcodebuild" };

/** Mirrors `sim_types::build_protocol::BuildDescriptor`. */
export interface BuildDescriptor {
  /** Omitted → the host picks the only shared scheme, or fails asking for one. */
  scheme?: string | null;
  configuration: Configuration;
  project: ProjectRef;
  env?: Record<string, string>;
  steps?: BuildStep[];
  /** Artifact path inside the workspace; omitted → the DerivedData default. */
  artifact_path?: string | null;
  timeout_seconds: number;
}

/** Mirrors `sim_types::build_protocol::FailureReason`. */
export type FailureReason =
  | "build_error"
  | "timeout"
  | "infra"
  | "cancelled"
  | "host_disconnected";

/** Mirrors `sim_types::build_protocol::BuildResult`. */
export type BuildResult =
  | { kind: "success"; artifact_path: string }
  | {
      kind: "failure";
      reason: FailureReason;
      exit_code: number | null;
      message: string | null;
    };

/** Mirrors sim-router's `BuildStatus` (serde `snake_case`). */
export type BuildStatus =
  | "queued"
  | "preparing"
  | "running"
  | "finalizing"
  | "succeeded"
  | "failed"
  | "cancelled";

/** `GET /builds/{id}` response. */
export interface BuildInfo {
  build_id: string;
  status: BuildStatus;
  result: BuildResult | null;
}

/** `POST /builds/{id}/cancel` response. `noop` means it was already terminal. */
export interface CancelResult {
  status: "accepted" | "noop";
  message: string;
}

/** `POST /builds/{id}/install` response. */
export interface InstallBuiltResult {
  status: string;
  message: string;
}
