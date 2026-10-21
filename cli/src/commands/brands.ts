import type { Command } from "commander";
import type { Context } from "../context.js";
import { formatBrands } from "./format.js";
import { act } from "./shared.js";

export function registerBrands(program: Command, ctx: Context): void {
  const brands = program.command("brands").description("the brands (brd_…) this login can make videos for");
  brands
    .command("list")
    .description("list brands")
    .action(
      act(ctx, async (rt) => {
        const api = await rt.api();
        const d = await api.get<Parameters<typeof formatBrands>[0]>("/brands");
        rt.out.result(d, { human: formatBrands, quiet: (b) => b.brands.map((x) => x.id).join("\n") });
      }),
    );
}
