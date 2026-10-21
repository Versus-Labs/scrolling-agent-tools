import { join } from "node:path";
import { configDir, ensureDir, readConfig, readJsonFile, writeConfig, writePrivateFile } from "../config.js";
import type { Context, Keyring } from "../context.js";
import type { Output } from "../output.js";

/**
 * Where a login is kept, and which credential a command uses:
 *
 *   1. SCROLLING_API_KEY (an API key from scrolling.ai settings) — CI and agents; always wins
 *   2. the OS keychain (service "scrolling-cli", account "<profile>@<origin>")
 *   3. credentials.json, 0600 in the 0700 config directory, when there is no usable keychain
 *      (headless Linux, containers) or with --insecure-storage; a one-time warning says so
 *
 * A login lives in one place: saving it in one removes it from the other.
 */

export type TokenSet = {
  access_token: string;
  refresh_token?: string;
  /** ms since the epoch */
  expires_at: number;
  scope: string;
  issuer: string;
  resource: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  client_id: string;
};

export type StoredSource = "keychain" | "file";
export type Credential = { source: "env"; apiKey: string } | { source: StoredSource; tokens: TokenSet };

export const KEYCHAIN_SERVICE = "scrolling-cli";

export const accountKey = (profile: string, origin: string) => `${profile}@${origin}`;

const CREDENTIALS_FILE = "credentials.json";

function isTokenSet(v: unknown): v is TokenSet {
  const t = v as TokenSet;
  return !!t && typeof t === "object" && typeof t.access_token === "string" && typeof t.expires_at === "number" && typeof t.token_endpoint === "string";
}

export class TokenStore {
  private keyring: Keyring | null | undefined;
  /** Where each login was read from: a refresh writes it back there. */
  private readonly loadedFrom = new Map<string, StoredSource>();

  constructor(
    private readonly ctx: Context,
    private readonly out: Output,
    private readonly opts: { insecure?: boolean } = {},
  ) {}

  private async kr(): Promise<Keyring | null> {
    if (this.keyring === undefined) this.keyring = await this.ctx.keyring();
    return this.keyring;
  }

  private filePath(): string {
    return join(configDir(this.ctx), CREDENTIALS_FILE);
  }

  private readFile(): Record<string, TokenSet> {
    const all = readJsonFile<Record<string, unknown>>(this.ctx, this.filePath()) ?? {};
    const out: Record<string, TokenSet> = {};
    for (const [k, v] of Object.entries(all)) if (isTokenSet(v)) out[k] = v;
    return out;
  }

  private writeFile(all: Record<string, TokenSet>): void {
    ensureDir(this.ctx);
    if (!Object.keys(all).length) {
      try {
        this.ctx.fs.unlinkSync(this.filePath());
      } catch {
        /* already gone */
      }
      return;
    }
    writePrivateFile(this.ctx, this.filePath(), JSON.stringify(all, null, 2) + "\n");
  }

  private async keychainGet(account: string): Promise<TokenSet | null> {
    if (this.opts.insecure) return null;
    const kr = await this.kr();
    if (!kr) return null;
    try {
      const raw = new kr.Entry(KEYCHAIN_SERVICE, account).getPassword();
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      return isTokenSet(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async keychainDelete(account: string): Promise<void> {
    const kr = await this.kr();
    if (!kr) return;
    try {
      new kr.Entry(KEYCHAIN_SERVICE, account).deletePassword();
    } catch {
      /* nothing stored, or no keychain */
    }
  }

  async load(account: string): Promise<{ tokens: TokenSet; source: StoredSource } | null> {
    const fromKeychain = await this.keychainGet(account);
    if (fromKeychain) {
      this.loadedFrom.set(account, "keychain");
      return { tokens: fromKeychain, source: "keychain" };
    }
    const fromFile = this.readFile()[account];
    if (!fromFile) return null;
    this.loadedFrom.set(account, "file");
    return { tokens: fromFile, source: "file" };
  }

  /** Saves a login; returns where it went. */
  async save(account: string, tokens: TokenSet): Promise<StoredSource> {
    if (!this.opts.insecure && this.loadedFrom.get(account) !== "file") {
      const kr = await this.kr();
      if (kr) {
        try {
          new kr.Entry(KEYCHAIN_SERVICE, account).setPassword(JSON.stringify(tokens));
          this.removeFromFile(account);
          return "keychain";
        } catch {
          // No usable keychain here (e.g. no Secret Service on a headless Linux): the file it is.
        }
      }
    }
    const all = this.readFile();
    all[account] = tokens;
    this.writeFile(all);
    if (this.loadedFrom.get(account) !== "file") {
      await this.keychainDelete(account);
      this.warnFileStorage();
    }
    this.loadedFrom.set(account, "file");
    return "file";
  }

  async remove(account: string): Promise<void> {
    await this.keychainDelete(account);
    this.removeFromFile(account);
  }

  private removeFromFile(account: string): void {
    const all = this.readFile();
    if (!(account in all)) return;
    delete all[account];
    this.writeFile(all);
  }

  private warnFileStorage(): void {
    if (this.opts.insecure) return;
    const cfg = readConfig(this.ctx);
    if (cfg.file_storage_warned) return;
    this.out.warn(`No system keychain available: your login is saved in ${this.filePath()} (readable only by you).`);
    writeConfig(this.ctx, { ...cfg, file_storage_warned: true });
  }
}

/** The credential a command runs with: SCROLLING_API_KEY, else the stored login, else null. */
export async function currentCredential(ctx: Context, store: TokenStore, account: string): Promise<Credential | null> {
  const key = ctx.env.SCROLLING_API_KEY?.trim();
  if (key) return { source: "env", apiKey: key };
  const stored = await store.load(account);
  return stored ? { source: stored.source, tokens: stored.tokens } : null;
}

// ── A device login waiting for approval (scrolling login --non-interactive → --complete) ──

export type PendingLogin = {
  device_code: string;
  user_code: string;
  verification_url: string;
  interval: number;
  /** ms since the epoch */
  expires_at: number;
  token_endpoint: string;
  revocation_endpoint?: string;
  issuer: string;
  resource: string;
  client_id: string;
  api_url: string;
};

const PENDING_FILE = "pending-login.json";

export function readPending(ctx: Context, account: string): PendingLogin | null {
  const all = readJsonFile<Record<string, PendingLogin>>(ctx, join(configDir(ctx), PENDING_FILE)) ?? {};
  return all[account] ?? null;
}

export function writePending(ctx: Context, account: string, pending: PendingLogin | null): void {
  const path = join(ensureDir(ctx), PENDING_FILE);
  const all = readJsonFile<Record<string, PendingLogin>>(ctx, path) ?? {};
  if (pending) all[account] = pending;
  else delete all[account];
  if (!Object.keys(all).length) {
    try {
      ctx.fs.unlinkSync(path);
    } catch {
      /* already gone */
    }
    return;
  }
  writePrivateFile(ctx, path, JSON.stringify(all, null, 2) + "\n");
}
