import type {
  BuildDescriptor,
  BuildInfo,
  CancelResult,
  InstallBuiltResult,
} from "../types.js";
import {
  BUILD_ID_HEADER,
  decodeBuildStream,
  type BuildFrame,
} from "../proto/build-stream.js";
import {
  jsonBody,
  requestBytes,
  requestJson,
  requestRaw,
  type HttpTransport,
} from "./transport.js";

/** A submitted build: its id, and its log stream still running. */
export interface SubmittedBuild {
  buildId: string;
  /**
   * The build's stdout/stderr as it runs, ending with the terminal `result`
   * frame. Consume it to completion (or abandon it) — the router holds the
   * stream open for the life of the build.
   */
  frames: AsyncGenerator<BuildFrame>;
}

/**
 * sim-router's remote-build API.
 *
 * Separate from `SimulatorApi` because a build needs no acquired machine — it
 * runs on a build host, and only `installBuilt` reaches for the session's
 * simulator.
 */
export class BuildsApi {
  constructor(private readonly transport: HttpTransport) {}

  /**
   * Submit a build. `source` is a `.tar.gz` of the project root.
   *
   * The response *is* the log stream: the router wires the relay up before the
   * build host is told to start, so no output can be produced with nobody
   * listening. The build id arrives in the `x-build-id` header, with the
   * headers — so `status`/`cancel`/`artifact` are available while the stream
   * is still open.
   */
  async submit(
    descriptor: BuildDescriptor,
    source: Uint8Array | Blob,
  ): Promise<SubmittedBuild> {
    const form = new FormData();
    // Descriptor first, and that ordering is the contract: the router rejects
    // a malformed descriptor before reading a single archive byte.
    form.append("descriptor", JSON.stringify({ descriptor }));
    form.append("source", source instanceof Blob ? source : blobOf(source), "source.tar.gz");

    const response = await requestRaw(this.transport, "/builds", {
      method: "POST",
      body: form,
    });

    const buildId = response.headers.get(BUILD_ID_HEADER);
    if (!buildId) {
      throw new Error(`build submitted without a ${BUILD_ID_HEADER} header`);
    }
    if (!response.body) {
      throw new Error("build submitted without a log stream body");
    }
    return { buildId, frames: decodeBuildStream(response.body) };
  }

  status(buildId: string): Promise<BuildInfo> {
    return requestJson(this.transport, `/builds/${encodeURIComponent(buildId)}`);
  }

  /** The built `.app.tar.gz`. Only a succeeded build has one. */
  artifact(buildId: string): Promise<Uint8Array> {
    return requestBytes(this.transport, `/builds/${encodeURIComponent(buildId)}/artifact`);
  }

  /** Cancelling an already-terminal build answers `noop`, not an error. */
  cancel(buildId: string): Promise<CancelResult> {
    return requestJson(this.transport, `/builds/${encodeURIComponent(buildId)}/cancel`, {
      method: "POST",
    });
  }

  /**
   * Install a succeeded build onto a simulator on the session's machine. The
   * router relays the artifact build-host → orchestrator without the tarball
   * passing through the client.
   */
  installBuilt(buildId: string, udid: string): Promise<InstallBuiltResult> {
    return requestJson(
      this.transport,
      `/builds/${encodeURIComponent(buildId)}/install`,
      jsonBody({ udid }),
    );
  }
}

/** `Blob` needs a real ArrayBuffer; a typed array may be a view into a larger one. */
function blobOf(bytes: Uint8Array): Blob {
  return new Blob([
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  ]);
}
