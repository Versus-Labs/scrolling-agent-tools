import * as fs from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { run } from "../src/cli.js";
import type { Context, Keyring, KeyringEntry } from "../src/context.js";

/**
 * A fake Context: captured stdout/stderr, a temporary config directory, a virtual clock (sleep
 * advances it at once), a fetch answered by `handler`, recorded spawns, an in-memory keychain
 * (or none). Nothing here reaches the network, the real keychain or ~/.config.
 */

export type Handler = (req: Request) => Response | Promise<Response>;
export type Captured = { stdout: string; stderr: string };

export type FakeOptions = {
  env?: Record<string, string | undefined>;
  handler?: Handler;
  /** stdout, stderr and stdin are terminals (default false) */
  tty?: boolean;
  keychain?: "memory" | "none" | "broken";
  answers?: string[];
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
};

export class MemoryKeychain {
  readonly items = new Map<string, string>();
  readonly keyring: Keyring;
  constructor(broken = false) {
    const items = this.items;
    class Entry implements KeyringEntry {
      constructor(
        private service: string,
        private account: string,
      ) {}
      private get k() {
        return `${this.service}/${this.account}`;
      }
      getPassword() {
        if (broken) throw new Error("no secret service");
        return items.get(this.k) ?? null;
      }
      setPassword(v: string) {
        if (broken) throw new Error("no secret service");
        items.set(this.k, v);
      }
      deletePassword() {
        if (broken) throw new Error("no secret service");
        return items.delete(this.k);
      }
    }
    this.keyring = { Entry };
  }
}

export type Fake = {
  ctx: Context;
  dir: string;
  out: Captured;
  requests: Request[];
  bodies: string[];
  spawns: { command: string; args: readonly string[]; opts: unknown }[];
  sleeps: number[];
  keychain: MemoryKeychain | null;
  clock: { t: number };
  run(...argv: string[]): Promise<number>;
};

export function fake(o: FakeOptions = {}): Fake {
  const dir = fs.mkdtempSync(join(tmpdir(), "scrolling-cli-test-"));
  const out: Captured = { stdout: "", stderr: "" };
  const requests: Request[] = [];
  const bodies: string[] = [];
  const spawns: Fake["spawns"] = [];
  const sleeps: number[] = [];
  const clock = { t: Date.UTC(2026, 9, 21, 12, 0, 0) };
  const keychain = o.keychain === "none" || o.keychain === undefined ? null : new MemoryKeychain(o.keychain === "broken");
  const answers = [...(o.answers ?? [])];
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = !!o.tty;
  const handler: Handler = o.handler ?? (() => new Response(JSON.stringify({ error: { code: "not_found", message: "no route" } }), { status: 404 }));
  const ctx: Context = {
    stdout: { write: (s: string) => ((out.stdout += s), true), isTTY: !!o.tty },
    stderr: { write: (s: string) => ((out.stderr += s), true), isTTY: !!o.tty },
    stdin,
    env: { XDG_CONFIG_HOME: dir, ...o.env },
    platform: o.platform ?? "linux",
    homedir: dir,
    hostname: "test-host",
    version: "0.0.0-test",
    now: () => clock.t,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      sleeps.push(ms);
      clock.t += ms;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req.clone());
      bodies.push(req.body ? await req.clone().text() : "");
      if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return handler(req);
    }) as typeof fetch,
    fs,
    spawn: (command, args, opts) => {
      spawns.push({ command, args, opts });
      return { on: () => undefined, unref: () => undefined };
    },
    createServer,
    randomBytes: (n) => randomBytes(n),
    randomUUID: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8000-${String(++i).padStart(12, "0")}`;
    })(),
    keyring: async () => keychain?.keyring ?? null,
    prompt: async () => answers.shift() ?? "",
    signal: o.signal ?? new AbortController().signal,
  };
  return { ctx, dir, out, requests, bodies, spawns, sleeps, keychain, clock, run: (...argv) => run(argv, ctx) };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

export const apiError = (status: number, code: string, message = code, details?: Record<string, unknown>, headers: Record<string, string> = {}) =>
  json({ error: { code, message, ...(details ? { details } : {}) } }, status, headers);

/** A route table: "METHOD /path" (path without query) → handler. Unknown routes 404. */
export function routes(table: Record<string, Handler>): Handler {
  return (req) => {
    const u = new URL(req.url);
    const h = table[`${req.method} ${u.pathname}`];
    return h ? h(req) : apiError(404, "not_found", `no route ${req.method} ${u.pathname}`);
  };
}

export const ORIGIN = "https://scrolling.test";
export const API_KEY = "scr_test_" + "A".repeat(32) + "abcdef";

/** The two discovery documents for ORIGIN (or another origin's endpoints, to test pinning). */
export function discoveryRoutes(origin = ORIGIN, endpointOrigin = origin): Record<string, Handler> {
  return {
    "GET /.well-known/oauth-protected-resource/api/v1": () => json({ resource: `${origin}/api/v1`, authorization_servers: [origin], scopes_supported: ["scrolling:read", "scrolling:create"] }),
    "GET /.well-known/oauth-authorization-server": () =>
      json({
        issuer: origin,
        authorization_endpoint: `${endpointOrigin}/oauth/authorize`,
        token_endpoint: `${endpointOrigin}/api/oauth/token`,
        revocation_endpoint: `${endpointOrigin}/api/oauth/revoke`,
        device_authorization_endpoint: `${endpointOrigin}/api/oauth/device`,
        code_challenge_methods_supported: ["S256"],
      }),
  };
}

export function parseStdout<T = Record<string, unknown>>(f: Fake): T {
  return JSON.parse(f.out.stdout) as T;
}

export function form(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

export const job = (status: string, extra: Record<string, unknown> = {}) => ({
  job: { id: "job_abc12345", kind: "render", status, progress: status === "succeeded" ? 100 : 40, step: 2, steps: 5, headline: "Filming", error: null, credits_held: 300, created_at: "2026-10-21T12:00:00Z", title: null, brand_id: "brd_x", video: null, ...extra },
  poll_after_seconds: 5,
  next_step: "…",
});
