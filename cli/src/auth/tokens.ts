import { join } from "node:path";
import { ensureDir } from "../config.js";
import type { Context } from "../context.js";
import { authError, CliError, EXIT } from "../exit-codes.js";
import { ApiError, send, userAgent, type AuthProvider } from "../http.js";
import type { Output } from "../output.js";
import type { TokenSet, TokenStore } from "./store.js";

/**
 * Tokens: the token endpoint (form posts), and the AuthProvider a stored login gives the API
 * client. Access tokens last an hour; a refresh happens a minute before expiry or after a 401,
 * under a lock file so two CLI processes never spend the same refresh token. When the answer
 * has no refresh_token (the server's answer to a refresh race), the stored one is kept.
 */

export const CLIENT_ID = "scrolling-cli";
export const GRANT = {
  code: "authorization_code",
  refresh: "refresh_token",
  device: "urn:ietf:params:oauth:grant-type:device_code",
} as const;

const EARLY_REFRESH_MS = 60_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

export type TokenResponse = { access_token: string; token_type?: string; expires_in?: number; refresh_token?: string; scope?: string };

/** A form POST to an OAuth endpoint: the status and the parsed JSON body (never throws on 4xx). */
export async function postForm(ctx: Context, out: Output, url: string, params: Record<string, string | undefined>): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, v);
  const res = await send(ctx, out, url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": userAgent(ctx) },
    body: form.toString(),
    redirect: "error",
  });
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

export function isTokenResponse(b: Record<string, unknown>): b is TokenResponse & Record<string, unknown> {
  return typeof b.access_token === "string" && b.access_token.length > 0;
}

/** The stored token set from a token response; `previousRefresh` stays when the response has none. */
export function toTokenSet(res: TokenResponse, base: Omit<TokenSet, "access_token" | "refresh_token" | "expires_at" | "scope">, now: number, previous?: Pick<TokenSet, "refresh_token" | "scope">): TokenSet {
  const refresh = typeof res.refresh_token === "string" && res.refresh_token ? res.refresh_token : previous?.refresh_token;
  return {
    ...base,
    access_token: res.access_token,
    ...(refresh ? { refresh_token: refresh } : {}),
    expires_at: now + Math.max(0, Number(res.expires_in ?? 3600)) * 1000,
    scope: typeof res.scope === "string" ? res.scope : (previous?.scope ?? ""),
  };
}

/** Everything in a token set but the tokens themselves. */
export function endpointsOf(t: Omit<TokenSet, "access_token" | "refresh_token" | "expires_at" | "scope">): Omit<TokenSet, "access_token" | "refresh_token" | "expires_at" | "scope"> {
  return {
    issuer: t.issuer,
    resource: t.resource,
    token_endpoint: t.token_endpoint,
    ...(t.revocation_endpoint ? { revocation_endpoint: t.revocation_endpoint } : {}),
    client_id: t.client_id,
  };
}

/** An OAuth error answer as a CliError. */
export function oauthFailure(status: number, body: Record<string, unknown>): CliError {
  const code = typeof body.error === "string" ? body.error : "error";
  const description = typeof body.error_description === "string" ? body.error_description : code.replace(/_/g, " ");
  if (code === "invalid_grant") return authError("Your login expired or was revoked. Run `scrolling login`.", "login_expired");
  return new ApiError(status, code, description);
}

/** Holds <config>/credentials.lock while `fn` runs (stale after 30 s; waits up to 15 s). */
export async function withLock<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
  const path = join(ensureDir(ctx), "credentials.lock");
  const deadline = ctx.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = ctx.fs.openSync(path, "wx", 0o600);
      ctx.fs.writeSync(fd, `${process.pid} ${ctx.now()}\n`);
      ctx.fs.closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let age = 0;
      try {
        age = ctx.now() - ctx.fs.statSync(path).mtimeMs;
      } catch {
        continue; // released meanwhile
      }
      if (age > LOCK_STALE_MS) {
        try {
          ctx.fs.unlinkSync(path);
        } catch {
          /* someone else cleared it */
        }
        continue;
      }
      if (ctx.now() > deadline) throw new CliError(`Another scrolling command is refreshing the login (${path}). Try again.`, EXIT.error, "locked");
      await ctx.sleep(200, ctx.signal);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      ctx.fs.unlinkSync(path);
    } catch {
      /* gone */
    }
  }
}

/** An API key from SCROLLING_API_KEY: nothing to refresh. */
export function apiKeyAuth(key: string): AuthProvider {
  return { header: async () => `Bearer ${key}`, refresh: async () => false };
}

/** A stored OAuth login: refreshes early, after a 401, and once per stale token. */
export class OAuthSession implements AuthProvider {
  constructor(
    private readonly ctx: Context,
    private readonly out: Output,
    private readonly store: TokenStore,
    private readonly account: string,
    private tokens: TokenSet,
  ) {}

  get current(): TokenSet {
    return this.tokens;
  }

  async header(): Promise<string> {
    if (this.tokens.expires_at - this.ctx.now() < EARLY_REFRESH_MS && this.tokens.refresh_token) await this.refresh(`Bearer ${this.tokens.access_token}`);
    return `Bearer ${this.tokens.access_token}`;
  }

  async refresh(used: string): Promise<boolean> {
    const usedToken = used.replace(/^Bearer /, "");
    return withLock(this.ctx, async () => {
      // Another process may have refreshed while we waited: use its tokens.
      const stored = (await this.store.load(this.account))?.tokens;
      if (stored && stored.access_token !== usedToken && stored.expires_at - this.ctx.now() > EARLY_REFRESH_MS) {
        this.tokens = stored;
        return true;
      }
      const base = stored ?? this.tokens;
      if (!base.refresh_token) return false;
      this.out.debug("refreshing the access token");
      const { status, body } = await postForm(this.ctx, this.out, base.token_endpoint, {
        grant_type: GRANT.refresh,
        refresh_token: base.refresh_token,
        client_id: base.client_id,
        resource: base.resource,
      });
      if (status !== 200 || !isTokenResponse(body)) throw oauthFailure(status, body);
      this.tokens = toTokenSet(body, endpointsOf(base), this.ctx.now(), base);
      await this.store.save(this.account, this.tokens);
      return true;
    });
  }
}
