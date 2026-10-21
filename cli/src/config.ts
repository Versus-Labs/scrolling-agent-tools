import { join } from "node:path";
import type { Context } from "./context.js";
import { usageError } from "./exit-codes.js";
import type { GlobalOptions } from "./output.js";

/**
 * Settings and the private files the CLI keeps: $XDG_CONFIG_HOME/scrolling (or
 * ~/.config/scrolling, %APPDATA%\scrolling on Windows), the directory 0700 and every file in
 * it 0600. config.json holds profiles (which server each talks to); never a secret.
 *
 * The server: SCROLLING_API_URL, else the profile's saved api_url (from its login), else
 * https://scrolling.ai. Plain http only for a loopback host (local development).
 */

export const DEFAULT_API_URL = "https://scrolling.ai";
export const DEFAULT_PROFILE = "default";

export type ProfileConfig = { api_url?: string };
export type ConfigFile = {
  profiles?: Record<string, ProfileConfig>;
  /** The one-time "saved in a file, not the keychain" warning was shown. */
  file_storage_warned?: boolean;
};

export type Settings = {
  profile: string;
  /** The server's origin, e.g. https://scrolling.ai */
  apiUrl: string;
  apiUrlSource: "env" | "profile" | "default";
  dir: string;
};

const PROFILE_NAME = /^[A-Za-z0-9_-]{1,40}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

/** The origin a server URL names, or a usage error: https, or http on a loopback host only. */
export function checkApiUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw usageError(`SCROLLING_API_URL is not a URL: ${raw}`);
  }
  if (u.username || u.password) throw usageError("SCROLLING_API_URL must not contain a user name or password.");
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return u.origin;
  throw usageError("SCROLLING_API_URL must be https:// (plain http:// only for localhost or 127.0.0.1).");
}

export function configDir(ctx: Context): string {
  const xdg = ctx.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "scrolling");
  if (ctx.platform === "win32" && ctx.env.APPDATA) return join(ctx.env.APPDATA, "scrolling");
  return join(ctx.homedir, ".config", "scrolling");
}

/** The config directory, created 0700 (and tightened if it exists with looser permissions). */
export function ensureDir(ctx: Context, dir = configDir(ctx)): string {
  ctx.fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (ctx.platform !== "win32") {
    const mode = ctx.fs.statSync(dir).mode & 0o777;
    if (mode !== 0o700) ctx.fs.chmodSync(dir, 0o700);
  }
  return dir;
}

/** Writes a file only its owner can read: a 0600 temp file renamed over the old one. */
export function writePrivateFile(ctx: Context, path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${ctx.randomBytes(4).toString("hex")}.tmp`;
  ctx.fs.writeFileSync(tmp, content, { mode: 0o600 });
  if (ctx.platform !== "win32") ctx.fs.chmodSync(tmp, 0o600);
  ctx.fs.renameSync(tmp, path);
}

export function readJsonFile<T>(ctx: Context, path: string): T | null {
  let text: string;
  try {
    text = ctx.fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function readConfig(ctx: Context): ConfigFile {
  return readJsonFile<ConfigFile>(ctx, join(configDir(ctx), "config.json")) ?? {};
}

export function writeConfig(ctx: Context, cfg: ConfigFile): void {
  const dir = ensureDir(ctx);
  writePrivateFile(ctx, join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
}

export function profileName(ctx: Context, opts: GlobalOptions): string {
  const name = opts.profile ?? ctx.env.SCROLLING_PROFILE ?? DEFAULT_PROFILE;
  if (!PROFILE_NAME.test(name)) throw usageError("A profile name is 1–40 letters, digits, - or _.");
  return name;
}

export function resolveSettings(ctx: Context, opts: GlobalOptions): Settings {
  const profile = profileName(ctx, opts);
  const dir = configDir(ctx);
  const envUrl = ctx.env.SCROLLING_API_URL;
  if (envUrl) return { profile, apiUrl: checkApiUrl(envUrl), apiUrlSource: "env", dir };
  const saved = readConfig(ctx).profiles?.[profile]?.api_url;
  if (saved) return { profile, apiUrl: checkApiUrl(saved), apiUrlSource: "profile", dir };
  return { profile, apiUrl: DEFAULT_API_URL, apiUrlSource: "default", dir };
}

/** Remembers which server a profile logged in to (so later commands need no SCROLLING_API_URL). */
export function saveProfileUrl(ctx: Context, profile: string, apiUrl: string): void {
  const cfg = readConfig(ctx);
  const profiles = { ...(cfg.profiles ?? {}) };
  if (apiUrl === DEFAULT_API_URL) {
    if (!profiles[profile]?.api_url) return;
    profiles[profile] = { ...profiles[profile], api_url: undefined };
  } else {
    if (profiles[profile]?.api_url === apiUrl) return;
    profiles[profile] = { ...profiles[profile], api_url: apiUrl };
  }
  writeConfig(ctx, { ...cfg, profiles });
}
