/**
 * Every non-2xx response from sim-router (and from the webui's Rust proxy)
 * carries `{ error, code? }`. `code` is the stable machine-readable slug from
 * `DomainError::code()` / `OperationError::code()` — match on it rather than on
 * the human-readable message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * `GET /simulators/{udid}/moq/direct` and `GET /direct` answer 409 when the
 * machine has no public host or the orchestrator runs no direct mux. That is a
 * routine "use the relay instead" signal, not a failure.
 */
export class MoqDirectUnavailableError extends ApiError {
  constructor(status: number, message: string, code?: string) {
    super(status, message, code);
    this.name = "MoqDirectUnavailableError";
  }
}

/** The router has no free machine right now; the caller may retry. */
export function isRetryable(error: unknown): boolean {
  return error instanceof ApiError && error.code === "machine_unavailable";
}

/**
 * A `simctl` invocation that ran and exited non-zero.
 *
 * Only the endpoints with a *dedicated* operation (install, app-container,
 * record, …) report a simctl failure this way — the router answers 400 with
 * `code: "simctl"` and the run's exit code and raw streams alongside the
 * message. The `/simctl` passthrough does not: there a non-zero exit is a
 * successful request whose `SpawnResult.exit` says no.
 *
 * `stdout`/`stderr` are the process's bytes verbatim, not text: a caller
 * standing in for `xcrun simctl` writes them straight through, and lossy UTF-8
 * decoding would rewrite anything that isn't.
 */
export class SimctlError extends ApiError {
  /** The simctl subcommand that failed, for log context. */
  readonly command: string | undefined;
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;

  constructor(
    status: number,
    message: string,
    details: {
      code?: string;
      command?: string;
      exitCode: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
    },
  ) {
    super(status, message, details.code);
    this.name = "SimctlError";
    this.command = details.command;
    this.exitCode = details.exitCode;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
  }
}

/**
 * The router speaks a different protocol version than this build.
 *
 * Not retryable and not something a client can work around — the peer has to
 * be updated. Raised by `assertProtocolVersion`.
 */
export class ProtocolVersionMismatchError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(
      `router speaks protocol v${actual}, this client speaks v${expected}; ` +
        "update whichever is older",
    );
    this.name = "ProtocolVersionMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}
