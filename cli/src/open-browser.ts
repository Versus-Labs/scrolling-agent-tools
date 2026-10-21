import { isLoopbackHost } from "./config.js";
import type { Context } from "./context.js";
import { CliError, EXIT } from "./exit-codes.js";
import type { Output } from "./output.js";

/**
 * Opens a login page in the system browser. Only our own pages: https (or http on a loopback
 * host, for local development) on the issuer's origin, nothing else (no javascript:, file:,
 * other sites). Launched with an argument list, never through a shell.
 */

export function checkBrowserUrl(raw: string, issuerOrigin: string): URL {
  const refuse = (why: string) => new CliError(`Refusing to open ${raw.slice(0, 80)}: ${why}.`, EXIT.error, "unsafe_url");
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) throw refuse("it contains spaces or control characters");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw refuse("not a URL");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) throw refuse("only https links (or http on localhost) are opened");
  if (u.username || u.password) throw refuse("it contains credentials");
  if (u.origin !== issuerOrigin) throw refuse(`it is not on ${issuerOrigin}`);
  return u;
}

/** The program and arguments that open a URL on this platform. */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/** Tries to open `url`; false when it couldn't be launched (the caller has printed the link anyway). */
export function openBrowser(ctx: Context, out: Output, url: string, issuerOrigin: string): boolean {
  const safe = checkBrowserUrl(url, issuerOrigin).toString();
  const [cmd, args] = browserCommand(ctx.platform, safe);
  try {
    const child = ctx.spawn(cmd, args, { stdio: "ignore", detached: true, shell: false, windowsHide: true });
    child.on("error", () => out.debug(`couldn't run ${cmd}`));
    child.unref();
    return true;
  } catch {
    return false;
  }
}
