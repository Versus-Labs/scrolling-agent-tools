import type { Command } from "commander";
import type { Context } from "../context.js";
import { formatProducts } from "./format.js";
import { act } from "./shared.js";

export function registerProducts(program: Command, ctx: Context): void {
  const products = program.command("products").description("a brand's products (prd_…), from its shop or website");
  products
    .command("list")
    .description("list a brand's products")
    .requiredOption("--brand <brd_id>", "the brand")
    .addHelpText("after", "\nExample:\n  $ scrolling products list --brand brd_abc123")
    .action(
      act(ctx, async (rt, _args, o) => {
        const api = await rt.api();
        const d = await api.get<Parameters<typeof formatProducts>[0]>("/products", { query: { brand_id: o.brand as string } });
        rt.out.result(d, { human: formatProducts, quiet: (p) => p.products.map((x) => x.id).join("\n") });
      }),
    );
}
