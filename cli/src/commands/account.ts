import type { Command } from "commander";
import type { Context } from "../context.js";
import { formatAccount } from "./format.js";
import { act } from "./shared.js";

export function registerAccount(program: Command, ctx: Context): void {
  program
    .command("account")
    .description("credits, plan, your role and the brands this login can use")
    .addHelpText("after", "\nExample:\n  $ scrolling account --json")
    .action(
      act(ctx, async (rt) => {
        const api = await rt.api();
        const d = await api.get<Parameters<typeof formatAccount>[0]>("/account");
        rt.out.result(d, { human: formatAccount, quiet: (a) => String(a.balance) });
      }),
    );
}
