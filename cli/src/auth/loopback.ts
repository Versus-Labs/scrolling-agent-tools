import type { AddressInfo } from "node:net";
import type { Context } from "../context.js";

/**
 * The loopback redirect of a browser login (RFC 8252 §7.3): a one-shot server on 127.0.0.1 and
 * an ephemeral port, path /callback. It takes one code, for our state, within 5 minutes; a
 * request with another state is refused without ending the login (a stale tab, or a page
 * trying its luck), and anything after the first good answer is refused.
 */

export const LOOPBACK_TTL_MS = 5 * 60_000;

export type CallbackResult = { ok: true; code: string } | { ok: false; error: string; description: string };
export type CallbackReply = { status: number; body: string; done?: CallbackResult };

const page = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · scrolling.ai</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body></html>`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The callback's logic (pure apart from the clock): what to answer, and whether the login is decided. */
export function callbackHandler(o: { state: string; issuer: string; expiresAt: number; now: () => number }) {
  let consumed = false;
  return (method: string, rawUrl: string): CallbackReply => {
    const url = new URL(rawUrl, "http://127.0.0.1");
    if (url.pathname !== "/callback") return { status: 404, body: page("Not found", "Nothing here.") };
    if (method !== "GET") return { status: 405, body: page("Not allowed", "Use the link from your browser.") };
    if (consumed) return { status: 400, body: page("Already used", "This login was already completed. You can close this tab.") };
    const q = url.searchParams;
    if (q.get("state") !== o.state) return { status: 400, body: page("Login link not recognised", "This isn't the login the CLI started. Run <code>scrolling login</code> again.") };
    consumed = true;
    if (o.now() > o.expiresAt) {
      return { status: 400, body: page("Login expired", "Run <code>scrolling login</code> again."), done: { ok: false, error: "expired_token", description: "The login took longer than 5 minutes." } };
    }
    const iss = q.get("iss");
    if (iss !== null && iss !== o.issuer) {
      return { status: 400, body: page("Login refused", "The answer came from another server."), done: { ok: false, error: "invalid_issuer", description: "The login answer came from another server." } };
    }
    const error = q.get("error");
    if (error) {
      const description = q.get("error_description") ?? (error === "access_denied" ? "The login was declined." : error);
      return { status: 200, body: page("Login cancelled", esc(description)), done: { ok: false, error, description } };
    }
    const code = q.get("code");
    if (!code) return { status: 400, body: page("Login failed", "No code came back."), done: { ok: false, error: "invalid_request", description: "No authorization code came back." } };
    return { status: 200, body: page("You're logged in", "The scrolling CLI is connected. You can close this tab and go back to your terminal."), done: { ok: true, code } };
  };
}

export type Loopback = {
  redirectUri: string;
  result: Promise<CallbackResult>;
  close(): void;
};

/** Starts the one-shot server on 127.0.0.1:0. */
export async function startLoopback(ctx: Context, o: { state: string; issuer: string; ttlMs?: number }): Promise<Loopback> {
  const ttl = o.ttlMs ?? LOOPBACK_TTL_MS;
  const handle = callbackHandler({ state: o.state, issuer: o.issuer, expiresAt: ctx.now() + ttl, now: ctx.now });
  let settle!: (r: CallbackResult) => void;
  let fail!: (e: unknown) => void;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const server = ctx.createServer((req, res) => {
    const reply = handle(req.method ?? "GET", req.url ?? "/");
    res.writeHead(reply.status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      Connection: "close",
    });
    res.end(reply.body);
    if (reply.done) settle(reply.done);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const timer = setTimeout(() => settle({ ok: false, error: "expired_token", description: "No answer from the browser within 5 minutes." }), ttl);
  timer.unref?.();
  const onAbort = () => fail(Object.assign(new Error("Interrupted"), { name: "AbortError" }));
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const close = () => {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
    server.closeAllConnections?.();
    server.close();
  };
  return { redirectUri: `http://127.0.0.1:${port}/callback`, result, close };
}
