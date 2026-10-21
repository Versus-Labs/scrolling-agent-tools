import type { Context } from "../context.js";
import type { Discovery } from "../discovery.js";
import { authError, CliError, EXIT } from "../exit-codes.js";
import type { Output } from "../output.js";
import { CLIENT_ID, GRANT, isTokenResponse, oauthFailure, postForm, type TokenResponse } from "./tokens.js";

/**
 * Device login (RFC 8628): the server gives a user code to type at /device and a device code
 * to poll with. Polls every `interval` seconds (5 by default); slow_down adds 5 s for good;
 * access_denied and expired_token end it.
 */

export type DeviceStart = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
};

export const DEFAULT_INTERVAL_S = 5;

function sameOrigin(raw: unknown, origin: string): raw is string {
  try {
    return typeof raw === "string" && new URL(raw).origin === origin;
  } catch {
    return false;
  }
}

export async function startDevice(ctx: Context, out: Output, disc: Discovery, scope: string): Promise<DeviceStart> {
  if (!disc.deviceEndpoint) throw new CliError("This server doesn't offer device login. Use `scrolling login` in a terminal with a browser.", EXIT.error, "unsupported");
  const { status, body } = await postForm(ctx, out, disc.deviceEndpoint, { client_id: CLIENT_ID, scope, resource: disc.resource, device_name: ctx.hostname.slice(0, 80) || undefined });
  if (status !== 200) throw oauthFailure(status, body);
  const origin = new URL(disc.issuer).origin;
  if (typeof body.device_code !== "string" || typeof body.user_code !== "string" || !sameOrigin(body.verification_uri, origin)) {
    throw new CliError("The server's device login answer isn't usable.", EXIT.error, "bad_response");
  }
  return {
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    ...(sameOrigin(body.verification_uri_complete, origin) ? { verification_uri_complete: body.verification_uri_complete } : {}),
    expires_in: Number(body.expires_in) > 0 ? Number(body.expires_in) : 600,
    interval: Number(body.interval) > 0 ? Number(body.interval) : DEFAULT_INTERVAL_S,
  };
}

export type PollStep = { kind: "wait"; interval: number } | { kind: "done"; tokens: TokenResponse } | { kind: "fail"; error: CliError };

/** What one poll's answer means (pure): wait (maybe slower), done, or fail. */
export function nextPoll(interval: number, status: number, body: Record<string, unknown>): PollStep {
  if (status === 200 && isTokenResponse(body)) return { kind: "done", tokens: body };
  switch (body.error) {
    case "authorization_pending":
      return { kind: "wait", interval };
    case "slow_down":
      return { kind: "wait", interval: interval + 5 };
    case "access_denied":
      return { kind: "fail", error: authError("The login was declined in the browser.", "access_denied") };
    case "expired_token":
      return { kind: "fail", error: authError("The login code expired. Run `scrolling login` again.", "expired_token") };
    default:
      if (body.error === "invalid_grant") return { kind: "fail", error: authError("This login code can't be used any more. Run `scrolling login` again.", "invalid_grant") };
      return { kind: "fail", error: oauthFailure(status, body) };
  }
}

/** Polls the token endpoint until the person approves, declines, or the code expires. */
export async function pollDevice(
  ctx: Context,
  out: Output,
  p: { deviceCode: string; tokenEndpoint: string; interval: number; expiresAt: number },
): Promise<TokenResponse> {
  let interval = p.interval;
  for (;;) {
    if (ctx.now() >= p.expiresAt) throw authError("The login code expired. Run `scrolling login` again.", "expired_token");
    await ctx.sleep(interval * 1000, ctx.signal);
    const { status, body } = await postForm(ctx, out, p.tokenEndpoint, { grant_type: GRANT.device, device_code: p.deviceCode, client_id: CLIENT_ID });
    const step = nextPoll(interval, status, body);
    if (step.kind === "done") return step.tokens;
    if (step.kind === "fail") throw step.error;
    if (step.interval !== interval) out.debug(`slow_down: polling every ${step.interval} s`);
    interval = step.interval;
  }
}
