import type { Command } from "commander";
import type { Context } from "../context.js";
import { formatCreators } from "./format.js";
import { act } from "./shared.js";

export function registerCreators(program: Command, ctx: Context): void {
  const creators = program.command("creators").description("Creators (cr_…): the people who appear in your videos");
  creators
    .command("list")
    .description("list Creators: the library and your brands' own")
    .option("--brand <brd_id>", "only this brand's own Creators (plus the library)")
    .addHelpText("after", "\nExample:\n  $ scrolling creators list --brand brd_abc123 --json")
    .action(
      act(ctx, async (rt, _args, o) => {
        const api = await rt.api();
        const d = await api.get<Parameters<typeof formatCreators>[0]>("/creators", { query: { brand_id: o.brand as string | undefined } });
        rt.out.result(d, { human: formatCreators, quiet: (c) => c.creators.map((x) => x.id).join("\n") });
      }),
    );
}
