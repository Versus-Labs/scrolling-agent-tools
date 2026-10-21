import type { Runtime } from "../runtime.js";
import { saveProfileUrl } from "../config.js";
import { discover, type Discovery } from "../discovery.js";
import { authError } from "../exit-codes.js";
import { openBrowser } from "../open-browser.js";
import { pollDevice, startDevice } from "./device.js";
import { startLoopback } from "./loopback.js";
import { newPkce, newState } from "./pkce.js";
import { readPending, writePending, type StoredSource, type TokenSet } from "./store.js";
import { CLIENT_ID, endpointsOf, GRANT, isTokenResponse, oauthFailure, postForm, toTokenSet, type TokenResponse } from "./tokens.js";

/**
 * `scrolling login`, three ways:
 *   - a browser on this machine (default): PKCE with a loopback redirect to 127.0.0.1;
 *   - --device: a code to type at scrolling.ai/device (SSH, containers, another machine);
 *   - non-interactive (no terminal, --no-input or --non-interactive): starts a device login,
 *     prints the link and code as JSON, keeps the device code 0600 and exits 0; an agent shows
 *     the link to its person and then runs `scrolling login --complete`.
 */

export type LoginOptions = {
  device?: boolean;
  /** false with --no-browser */
  browser?: boolean;
  nonInteractive?: boolean;
  complete?: boolean;
  readOnly?: boolean;
};

export type LoginDone = { logged_in: true; profile: string; api_url: string; scope: string; storage: StoredSource };
export type LoginPending = { verification_url: string; user_code: string; expires_in: number; next: string };

export const SCOPE_ALL = "scrolling:read scrolling:create";
export const SCOPE_READ = "scrolling:read";

function completeCommand(rt: Runtime): string {
  return rt.settings.profile === "default" ? "scrolling login --complete" : `scrolling login --complete --profile ${rt.settings.profile}`;
}

async function finish(rt: Runtime, disc: Pick<Discovery, "issuer" | "resource" | "tokenEndpoint" | "revocationEndpoint">, res: TokenResponse): Promise<LoginDone> {
  const tokens: TokenSet = toTokenSet(
    res,
    endpointsOf({ issuer: disc.issuer, resource: disc.resource, token_endpoint: disc.tokenEndpoint, revocation_endpoint: disc.revocationEndpoint, client_id: CLIENT_ID }),
    rt.ctx.now(),
  );
  const storage = await rt.store.save(rt.account, tokens);
  saveProfileUrl(rt.ctx, rt.settings.profile, rt.settings.apiUrl);
  writePending(rt.ctx, rt.account, null);
  if (rt.ctx.env.SCROLLING_API_KEY) rt.out.warn("SCROLLING_API_KEY is set, so commands keep using that key instead of this login until you unset it.");
  return { logged_in: true, profile: rt.settings.profile, api_url: rt.settings.apiUrl, scope: tokens.scope, storage };
}

export async function login(rt: Runtime, o: LoginOptions): Promise<LoginDone | LoginPending> {
  if (o.complete) return completeLogin(rt);
  const scope = o.readOnly ? SCOPE_READ : SCOPE_ALL;
  const disc = await discover(rt.ctx, rt.out, rt.settings.apiUrl);
  const issuerOrigin = new URL(disc.issuer).origin;

  if (o.nonInteractive || !rt.out.interactive(rt.opts)) {
    const start = await startDevice(rt.ctx, rt.out, disc, scope);
    writePending(rt.ctx, rt.account, {
      device_code: start.device_code,
      user_code: start.user_code,
      verification_url: start.verification_uri_complete ?? start.verification_uri,
      interval: start.interval,
      expires_at: rt.ctx.now() + start.expires_in * 1000,
      token_endpoint: disc.tokenEndpoint,
      ...(disc.revocationEndpoint ? { revocation_endpoint: disc.revocationEndpoint } : {}),
      issuer: disc.issuer,
      resource: disc.resource,
      client_id: CLIENT_ID,
      api_url: rt.settings.apiUrl,
    });
    return { verification_url: start.verification_uri_complete ?? start.verification_uri, user_code: start.user_code, expires_in: start.expires_in, next: completeCommand(rt) };
  }

  if (!o.device) {
    const done = await loopbackLogin(rt, disc, scope, o.browser !== false).catch((e: unknown) => {
      // No local port here (a sandbox, a locked-down container): a device login still works.
      if ((e as NodeJS.ErrnoException)?.code === "EACCES" || (e as NodeJS.ErrnoException)?.code === "EPERM") return null;
      throw e;
    });
    if (done) return finish(rt, disc, done);
    rt.out.info("Can't open a local port for the browser to come back to; using a login code instead.");
  }

  const start = await startDevice(rt.ctx, rt.out, disc, scope);
  const link = start.verification_uri_complete ?? start.verification_uri;
  rt.out.info(`To log in, open ${link}\nand check that it shows the code ${start.user_code}.`);
  if (o.browser !== false) openBrowser(rt.ctx, rt.out, link, issuerOrigin);
  rt.out.info("Waiting for you to approve the login…");
  const res = await pollDevice(rt.ctx, rt.out, { deviceCode: start.device_code, tokenEndpoint: disc.tokenEndpoint, interval: start.interval, expiresAt: rt.ctx.now() + start.expires_in * 1000 });
  return finish(rt, disc, res);
}

async function loopbackLogin(rt: Runtime, disc: Discovery, scope: string, browser: boolean): Promise<TokenResponse> {
  const pkce = newPkce(rt.ctx);
  const state = newState(rt.ctx);
  const server = await startLoopback(rt.ctx, { state, issuer: disc.issuer });
  try {
    const url = new URL(disc.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", server.redirectUri);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("scope", scope);
    url.searchParams.set("resource", disc.resource);
    const link = url.toString();
    const opened = browser && openBrowser(rt.ctx, rt.out, link, new URL(disc.issuer).origin);
    rt.out.info(`${opened ? "Opened your browser to log in. If it didn't open, go to" : "To log in, open this link in a browser on this computer"}:\n${link}`);
    rt.out.info("Waiting for the browser…");
    const result = await server.result;
    if (!result.ok) throw authError(result.description, result.error);
    const { status, body } = await postForm(rt.ctx, rt.out, disc.tokenEndpoint, {
      grant_type: GRANT.code,
      code: result.code,
      redirect_uri: server.redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
      resource: disc.resource,
    });
    if (status !== 200 || !isTokenResponse(body)) throw oauthFailure(status, body);
    return body;
  } finally {
    server.close();
  }
}

/** `scrolling login --complete`: waits for the approval of the login a non-interactive `login` started. */
export async function completeLogin(rt: Runtime): Promise<LoginDone> {
  const pending = readPending(rt.ctx, rt.account);
  if (!pending) throw authError("No login is waiting to be completed. Run `scrolling login` first.", "no_pending_login");
  if (pending.expires_at <= rt.ctx.now()) {
    writePending(rt.ctx, rt.account, null);
    throw authError("The login code expired. Run `scrolling login` again.", "expired_token");
  }
  rt.out.info(`Waiting for the login to be approved at ${pending.verification_url} (code ${pending.user_code})…`);
  try {
    const res = await pollDevice(rt.ctx, rt.out, { deviceCode: pending.device_code, tokenEndpoint: pending.token_endpoint, interval: pending.interval, expiresAt: pending.expires_at });
    return await finish(rt, { issuer: pending.issuer, resource: pending.resource, tokenEndpoint: pending.token_endpoint, revocationEndpoint: pending.revocation_endpoint }, res);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "access_denied" || code === "expired_token" || code === "invalid_grant") writePending(rt.ctx, rt.account, null);
    throw e;
  }
}

export type LogoutResult = { logged_out: boolean; revoked: boolean; profile: string; api_url: string };

/** `scrolling logout`: revokes the refresh token (which ends the whole login on the server) and forgets it here. */
export async function logout(rt: Runtime): Promise<LogoutResult> {
  const stored = await rt.store.load(rt.account);
  let revoked = false;
  if (stored?.tokens.revocation_endpoint) {
    const t = stored.tokens;
    const token = t.refresh_token ?? t.access_token;
    try {
      const { status } = await postForm(rt.ctx, rt.out, t.revocation_endpoint!, { token, token_type_hint: t.refresh_token ? "refresh_token" : "access_token", client_id: t.client_id });
      revoked = status === 200;
    } catch (e) {
      rt.out.debug(`revocation failed: ${(e as Error).message}`);
    }
    if (!revoked) rt.out.warn("Couldn't reach the server to end the login there; it was removed from this computer. You can also disconnect it in scrolling.ai settings.");
  }
  await rt.store.remove(rt.account);
  writePending(rt.ctx, rt.account, null);
  if (rt.ctx.env.SCROLLING_API_KEY) rt.out.warn("SCROLLING_API_KEY is still set: commands keep using it. Unset it (and revoke the key in scrolling.ai settings if it should stop working).");
  return { logged_out: !!stored, revoked, profile: rt.settings.profile, api_url: rt.settings.apiUrl };
}

export type AuthStatus = {
  logged_in: boolean;
  profile: string;
  api_url: string;
  api_url_source: "env" | "profile" | "default";
  source: "env" | StoredSource | null;
  scope: string | null;
  /** The current access token's expiry (it refreshes itself). */
  access_expires_at: string | null;
  /** A saved login SCROLLING_API_KEY is overriding. */
  overridden_login: StoredSource | null;
  pending_login: boolean;
};

export async function authStatus(rt: Runtime): Promise<AuthStatus> {
  const stored = await rt.store.load(rt.account);
  const envKey = !!rt.ctx.env.SCROLLING_API_KEY?.trim();
  if (envKey) rt.out.warn(`Using SCROLLING_API_KEY from the environment${stored ? `; it overrides the login saved in the ${stored.source}` : ""}.`);
  return {
    logged_in: envKey || !!stored,
    profile: rt.settings.profile,
    api_url: rt.settings.apiUrl,
    api_url_source: rt.settings.apiUrlSource,
    source: envKey ? "env" : (stored?.source ?? null),
    scope: envKey ? null : (stored?.tokens.scope ?? null),
    access_expires_at: envKey || !stored ? null : new Date(stored.tokens.expires_at).toISOString(),
    overridden_login: envKey && stored ? stored.source : null,
    pending_login: !!readPending(rt.ctx, rt.account),
  };
}
