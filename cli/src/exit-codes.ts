/**
 * Exit codes: a stable contract for scripts and agents (README, the skill). Never renumber.
 *
 *   0    ok
 *   1    error (also busy / rate limited: retry after `retry_after` seconds)
 *   2    usage: a bad flag or input
 *   3    auth: not logged in, login expired, or the connection may not do this
 *   4    not found
 *   5    duplicate: the Idempotency-Key was used for a different request (or is too old)
 *   6    credits, plan or monthly credit cap: ask the person, don't retry
 *   7    still running (a wait timed out): resume with `scrolling jobs wait <id>`
 *   8    the job failed or was cancelled
 *   9    confirmation required: show the price, then run again with --yes
 *   130  interrupted (Ctrl-C)
 */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  duplicate: 5,
  payment: 6,
  stillRunning: 7,
  jobFailed: 8,
  confirm: 9,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

const AUTH_CODES = new Set(["unauthorized", "invalid_token", "insufficient_scope", "agent_beta", "agent_read_only", "forbidden", "role", "not_logged_in", "login_expired", "access_denied", "expired_token", "invalid_grant"]);
const PAYMENT_CODES = new Set(["credits", "plan", "credit_cap"]);
const DUPLICATE_CODES = new Set(["idempotency_conflict", "idempotency_expired"]);
const USAGE_CODES = new Set(["invalid_input", "invalid_request", "seconds_required", "invalid_file", "too_large", "unsupported_type", "usage"]);
/** Codes that are worth retrying later (exit 1). */
const RETRY_CODES = new Set(["busy", "rate_limited", "idempotency_in_progress", "unavailable", "agent_access_off"]);

/** The exit code for an API (or OAuth) error, by its code first, then its HTTP status. */
export function exitForError(status: number, code: string): ExitCode {
  if (code === "confirmation_required" || status === 428) return EXIT.confirm;
  if (PAYMENT_CODES.has(code) || status === 402) return EXIT.payment;
  if (DUPLICATE_CODES.has(code)) return EXIT.duplicate;
  if (RETRY_CODES.has(code)) return EXIT.error;
  if (AUTH_CODES.has(code) || status === 401 || status === 403) return EXIT.auth;
  if (code === "not_found" || status === 404) return EXIT.notFound;
  if (USAGE_CODES.has(code) || status === 400 || status === 413 || status === 415 || status === 422) return EXIT.usage;
  return EXIT.error;
}

/** An error the CLI reports and exits with. `message` is safe to show; `details` goes in the JSON error. */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: ExitCode,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const usageError = (message: string) => new CliError(message, EXIT.usage, "usage");
export const authError = (message: string, code = "unauthorized") => new CliError(message, EXIT.auth, code);
