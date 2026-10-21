import type { Command } from "commander";
import { authStatus, login, logout, type LoginDone, type LoginPending } from "../auth/login.js";
import type { Context } from "../context.js";
import { authError } from "../exit-codes.js";
import { act } from "./shared.js";

export function registerAuth(program: Command, ctx: Context): void {
  program
    .command("login")
    .description("log in to scrolling.ai (opens your browser)")
    .option("--device", "log in with a code typed at scrolling.ai/device (SSH, containers, another computer)")
    .option("--no-browser", "don't open a browser; print the link instead")
    .option("--non-interactive", "for agents: print the login link and code as JSON and exit (automatic without a terminal)")
    .option("--complete", "finish a login started with --non-interactive (waits for the approval)")
    .option("--read-only", "ask only to read (no videos, no spending)")
    .option("--insecure-storage", "keep the login in a 0600 file instead of the system keychain")
    .addHelpText(
      "after",
      `
Examples:
  $ scrolling login                      # browser on this computer
  $ scrolling login --device             # type a code at scrolling.ai/device
  $ scrolling login --non-interactive    # agents: prints {verification_url, user_code, next}
  $ scrolling login --complete           # then wait for the person to approve
  $ SCROLLING_API_URL=http://localhost:3007 scrolling login --profile local`,
    )
    .action(
      act(ctx, async (rt, _args, o) => {
        const res = await login(rt, {
          device: !!o.device,
          browser: o.browser !== false,
          nonInteractive: !!o.nonInteractive,
          complete: !!o.complete,
          readOnly: !!o.readOnly,
        });
        if ("verification_url" in res) {
          const p = res as LoginPending;
          rt.out.result(p, { human: () => `Open ${p.verification_url}\nand check that it shows the code ${p.user_code}. Then run: ${p.next}` });
          return;
        }
        const d = res as LoginDone;
        rt.out.success(`Logged in to ${d.api_url} (${d.scope.includes("scrolling:create") ? "read and create" : "read only"}; saved in the ${d.storage}).`);
        rt.out.result(d, { human: () => "" });
      }),
    );

  program
    .command("logout")
    .description("log out: ends the login on the server and removes it from this computer")
    .action(
      act(ctx, async (rt) => {
        const r = await logout(rt);
        rt.out.result(r, { human: () => (r.logged_out ? `Logged out of ${r.api_url}.` : `No saved login for ${r.api_url}.`) });
      }),
    );

  const auth = program.command("auth").description("check how the CLI is logged in");
  auth
    .command("status")
    .description("show which credential is used (SCROLLING_API_KEY, keychain or file) and for which server")
    .action(
      act(ctx, async (rt) => {
        const s = await authStatus(rt);
        rt.out.result(s, {
          human: () =>
            s.logged_in
              ? `Logged in to ${s.api_url} (profile ${s.profile}) with ${s.source === "env" ? "SCROLLING_API_KEY" : `a login saved in the ${s.source}`}${s.scope ? `; may ${s.scope.includes("scrolling:create") ? "read and create" : "read only"}` : ""}.`
              : `Not logged in to ${s.api_url} (profile ${s.profile}).${s.pending_login ? " A login is waiting: scrolling login --complete" : " Run: scrolling login"}`,
        });
        if (!s.logged_in) throw authError("Not logged in.", "not_logged_in");
      }),
    );
}
