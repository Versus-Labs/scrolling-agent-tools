import type { Context } from "./context.js";
import { isAbort } from "./context.js";
import { CliError, EXIT, exitForError } from "./exit-codes.js";
import type { Output } from "./output.js";

/**
 * The REST client for /api/v1. Errors come back as { error: { code, message, details? } } and
 * become an ApiError (a CliError with the exit code for that code). With an OAuth login a 401
 * gets one refresh and one retry. GETs are retried on 502/503/504 and network errors; a POST
 * only when it carries an Idempotency-Key, and always with the same key, so a retry can never
 * start a second job.
 */

export class ApiError extends CliError {
  constructor(
    public readonly status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    public readonly retryAfter?: number,
  ) {
    super(message, exitForError(status, code), code, retryAfter !== undefined ? { ...details, retry_after: retryAfter } : details);
    this.name = "ApiError";
  }
}

export type AuthProvider = {
  /** The Authorization header value. */
  header(): Promise<string>;
  /** After a 401 with `used`: a fresh token (true), or nothing to try (false: an API key). */
  refresh(used: string): Promise<boolean>;
};

export type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

const RETRY_STATUS = new Set([502, 503, 504]);
const MAX_RETRIES = 2;

export function userAgent(ctx: Context): string {
  return `scrolling-cli/${ctx.version} node/${process.versions.node} ${ctx.platform}`;
}

function retryAfterOf(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined;
}

/** An ApiError from an error response: our { error: { code, message } }, an OAuth { error, error_description }, or a bare status. */
export async function errorFromResponse(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const retryAfter = retryAfterOf(res);
  const err = (body as { error?: unknown } | null)?.error;
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown; details?: unknown };
    const details = e.details && typeof e.details === "object" && !Array.isArray(e.details) ? (e.details as Record<string, unknown>) : undefined;
    return new ApiError(res.status, typeof e.code === "string" ? e.code : "error", typeof e.message === "string" ? e.message : `The server answered ${res.status}.`, details, retryAfter);
  }
  if (typeof err === "string") {
    const description = (body as { error_description?: unknown }).error_description;
    return new ApiError(res.status, err, typeof description === "string" ? description : err.replace(/_/g, " "), undefined, retryAfter);
  }
  // Never echo an unknown body (an HTML error page, a proxy's text).
  return new ApiError(res.status, res.status >= 500 ? "unavailable" : "error", `The server answered ${res.status}${res.status >= 500 ? "; try again in a moment" : ""}.`, undefined, retryAfter);
}

export function networkError(e: unknown, url: string, details?: Record<string, unknown>): CliError {
  const cause = (e as { cause?: { code?: string } })?.cause?.code;
  return new CliError(`Couldn't reach ${new URL(url).host}${cause ? ` (${cause})` : ""}. Check your connection and try again.`, EXIT.error, "network", details);
}

/** fetch with --debug logging (URL and status only, secrets redacted) and a network error a person can read. */
export async function send(ctx: Context, out: Output, url: string, init: RequestInit, details?: Record<string, unknown>): Promise<Response> {
  const started = ctx.now();
  const method = init.method ?? "GET";
  let res: Response;
  try {
    res = await ctx.fetch(url, { ...init, signal: init.signal ?? ctx.signal });
  } catch (e) {
    if (isAbort(e)) throw e;
    out.debug(`${method} ${url} failed: ${(e as Error).message}`);
    throw networkError(e, url, details);
  }
  out.debug(`${method} ${url} → ${res.status} (${ctx.now() - started} ms)`);
  return res;
}

export class Api {
  constructor(
    private readonly ctx: Context,
    private readonly out: Output,
    /** The server's origin. */
    readonly origin: string,
    private readonly auth: AuthProvider | null,
  ) {}

  url(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(`${this.origin}/api/v1${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, opts);
  }

  post<T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, { ...opts, body });
  }

  delete<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, opts);
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.url(path, opts.query);
    const retryable = method === "GET" || !!opts.idempotencyKey;
    const details = opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : undefined;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { Accept: "application/json", "User-Agent": userAgent(this.ctx) };
      const authHeader = this.auth ? await this.auth.header() : null;
      if (authHeader) headers.Authorization = authHeader;
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
      let res: Response;
      try {
        res = await send(this.ctx, this.out, url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: opts.signal }, details);
      } catch (e) {
        if (retryable && attempt < MAX_RETRIES && e instanceof CliError && e.code === "network") {
          await this.ctx.sleep(500 * 2 ** attempt, opts.signal ?? this.ctx.signal);
          continue;
        }
        throw e;
      }
      if (res.status === 401 && this.auth && authHeader && !refreshed) {
        const err = await errorFromResponse(res);
        refreshed = true;
        if (await this.auth.refresh(authHeader)) {
          attempt--;
          continue;
        }
        throw new ApiError(401, err.code, `${err.message} Run \`scrolling login\` (or check SCROLLING_API_KEY).`, err.details);
      }
      if (RETRY_STATUS.has(res.status) && retryable && attempt < MAX_RETRIES) {
        const after = retryAfterOf(res);
        await res.body?.cancel().catch(() => {});
        await this.ctx.sleep(after !== undefined && after <= 10 ? after * 1000 : 500 * 2 ** attempt, opts.signal ?? this.ctx.signal);
        continue;
      }
      if (!res.ok) {
        const err = await errorFromResponse(res);
        if (res.status === 401) throw new ApiError(401, err.code, `${err.message} Run \`scrolling login\` (or check SCROLLING_API_KEY).`, err.details);
        throw err;
      }
      if (res.status === 204) return null as T;
      const text = await res.text();
      try {
        return (text ? JSON.parse(text) : null) as T;
      } catch {
        throw new CliError("The server sent an answer the CLI can't read.", EXIT.error, "bad_response");
      }
    }
  }
}
