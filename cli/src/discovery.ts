import type { Context } from "./context.js";
import { CliError, EXIT } from "./exit-codes.js";
import { errorFromResponse, send, userAgent } from "./http.js";
import type { Output } from "./output.js";

/**
 * Where to log in, discovered from the server and pinned to it: the protected resource metadata
 * for /api/v1 (RFC 9728) names the authorization server, whose metadata (RFC 8414) names the
 * endpoints. The issuer and every endpoint must be on the very origin the CLI talks to, so a
 * tampered document can never send a login (or a token) anywhere else.
 */

export type Discovery = {
  issuer: string;
  /** The audience tokens are bound to (API_RESOURCE_URL). */
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  deviceEndpoint?: string;
};

const mismatch = (what: string) =>
  new CliError(`The server's login settings point somewhere else (${what}). Refusing to log in; check SCROLLING_API_URL.`, EXIT.error, "discovery_mismatch");

function sameOrigin(raw: unknown, origin: string, what: string): string {
  if (typeof raw !== "string" || !raw) throw mismatch(`${what} missing`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw mismatch(`${what} is not a URL`);
  }
  if (u.origin !== origin || u.username || u.password) throw mismatch(`${what} is on ${u.origin}`);
  return raw;
}

/** RFC 8414 §3: the metadata URL for an issuer (well-known inserted before any path). */
export function asMetadataUrl(issuer: string): string {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.origin}/.well-known/oauth-authorization-server${path}`;
}

/** Checks both documents against the server's origin (pure). */
export function checkDiscovery(origin: string, prm: unknown, asm: unknown, issuerFromPrm?: string): Discovery {
  const p = (prm ?? {}) as { resource?: unknown; authorization_servers?: unknown };
  const resource = sameOrigin(p.resource, origin, "resource");
  const servers = Array.isArray(p.authorization_servers) ? p.authorization_servers : [];
  const issuer = sameOrigin(issuerFromPrm ?? servers[0], origin, "authorization server");
  const a = (asm ?? {}) as Record<string, unknown>;
  if (a.issuer !== issuer) throw mismatch("issuer differs from the authorization server");
  const methods = a.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) throw mismatch("no PKCE S256");
  return {
    issuer,
    resource,
    authorizationEndpoint: sameOrigin(a.authorization_endpoint, origin, "authorization endpoint"),
    tokenEndpoint: sameOrigin(a.token_endpoint, origin, "token endpoint"),
    revocationEndpoint: a.revocation_endpoint === undefined ? undefined : sameOrigin(a.revocation_endpoint, origin, "revocation endpoint"),
    deviceEndpoint: a.device_authorization_endpoint === undefined ? undefined : sameOrigin(a.device_authorization_endpoint, origin, "device endpoint"),
  };
}

async function getJson(ctx: Context, out: Output, url: string): Promise<unknown> {
  // redirect: "error": a document must be served where we asked for it.
  const res = await send(ctx, out, url, { headers: { Accept: "application/json", "User-Agent": userAgent(ctx) }, redirect: "error" });
  if (!res.ok) throw await errorFromResponse(res);
  try {
    return await res.json();
  } catch {
    throw new CliError(`${url} is not a JSON document.`, EXIT.error, "discovery_failed");
  }
}

export async function discover(ctx: Context, out: Output, origin: string): Promise<Discovery> {
  const prm = await getJson(ctx, out, `${origin}/.well-known/oauth-protected-resource/api/v1`);
  const servers = (prm as { authorization_servers?: unknown })?.authorization_servers;
  const issuer = sameOrigin(Array.isArray(servers) ? servers[0] : undefined, origin, "authorization server");
  const asm = await getJson(ctx, out, asMetadataUrl(issuer));
  return checkDiscovery(origin, prm, asm, issuer);
}
