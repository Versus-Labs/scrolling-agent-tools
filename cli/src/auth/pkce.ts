import { createHash } from "node:crypto";
import type { Context } from "../context.js";

/** PKCE (RFC 7636, S256 only) and the state parameter. */

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** A 43-character verifier (32 random bytes) and its challenge. */
export function newPkce(ctx: Pick<Context, "randomBytes">): { verifier: string; challenge: string } {
  const verifier = ctx.randomBytes(32).toString("base64url");
  return { verifier, challenge: s256(verifier) };
}

export function newState(ctx: Pick<Context, "randomBytes">): string {
  return ctx.randomBytes(24).toString("base64url");
}
