import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { homedir, hostname } from "node:os";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Everything the CLI touches outside itself, passed in: streams, environment, clock, network,
 * files, processes and the keychain. bin.ts builds the real one; tests build their own, so
 * nothing in a test reaches the network, the real keychain or the real config directory.
 */

export type OutStream = { write(chunk: string): unknown; isTTY?: boolean };
export type InStream = NodeJS.ReadableStream & { isTTY?: boolean };

/** The part of @napi-rs/keyring the CLI uses. */
export type KeyringEntry = { getPassword(): string | null | undefined; setPassword(value: string): void; deletePassword(): boolean | void };
export type Keyring = { Entry: new (service: string, account: string) => KeyringEntry };

export type SpawnFn = (command: string, args: readonly string[], opts: { stdio: "ignore"; detached: boolean; shell: false; windowsHide: boolean }) => {
  on(event: "error", cb: (e: Error) => void): unknown;
  unref(): void;
};

export type CreateServerFn = typeof createServer;

export type Context = {
  stdout: OutStream;
  stderr: OutStream;
  stdin: InStream;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homedir: string;
  /** Sent as device_name with a device login (shown on the approval page). */
  hostname: string;
  version: string;
  now(): number;
  /** Resolves after `ms`, rejects with an AbortError when `signal` fires. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  fetch: typeof fetch;
  fs: typeof fs;
  spawn: SpawnFn;
  createServer: CreateServerFn;
  randomBytes(n: number): Buffer;
  randomUUID(): string;
  /** Loads @napi-rs/keyring lazily; null when it isn't installed or can't load on this system. */
  keyring(): Promise<Keyring | null>;
  /** One line typed by the person (only asked when stdin is a terminal). */
  prompt(question: string, signal?: AbortSignal): Promise<string>;
  /** Fires on Ctrl-C. */
  signal: AbortSignal;
};

async function loadKeyring(): Promise<Keyring | null> {
  try {
    const mod = (await import("@napi-rs/keyring")) as unknown as Keyring & { default?: Keyring };
    return mod.Entry ? mod : (mod.default ?? null);
  } catch {
    return null;
  }
}

function readLine(question: string, stdin: InStream, stderr: OutStream, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: stdin, output: stderr as NodeJS.WritableStream, terminal: !!stdin.isTTY });
    const onAbort = () => {
      rl.close();
      reject(Object.assign(new Error("Interrupted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    rl.question(question, (answer) => {
      signal?.removeEventListener("abort", onAbort);
      rl.close();
      resolve(answer);
    });
  });
}

export function realContext(version: string, signal: AbortSignal): Context {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    hostname: hostname(),
    version,
    now: () => Date.now(),
    sleep: (ms, s) => delay(ms, undefined, { signal: s }),
    fetch: globalThis.fetch.bind(globalThis),
    fs,
    spawn: (command, args, opts) => spawn(command, args, opts),
    createServer,
    randomBytes: (n) => randomBytes(n),
    randomUUID: () => randomUUID(),
    keyring: loadKeyring,
    prompt: (q, s) => readLine(q, process.stdin, process.stderr, s),
    signal,
  };
}

/** An AbortError (Ctrl-C, or an aborted fetch/sleep). */
export function isAbort(e: unknown): boolean {
  return !!e && typeof e === "object" && ((e as Error).name === "AbortError" || (e as { code?: string }).code === "ABORT_ERR");
}
