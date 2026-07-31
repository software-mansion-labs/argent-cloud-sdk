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
