import type { Command } from "commander";
import type { Context } from "../context.js";
import { usageError } from "../exit-codes.js";
import { act, compact, idList, qualityArg, startJob, videoSource, withSpendOptions, withWaitOptions } from "./shared.js";

export function registerRemake(program: Command, ctx: Context): void {
  const remake = program
    .command("remake")
    .description("Remake: study an ad that works and rewrite it for your brand, then film it")
    .addHelpText(
      "after",
      `
Examples:
  $ scrolling remake --brand brd_abc --video https://www.tiktok.com/@shop/video/123 --wait   # free: writes the script
  $ scrolling remake film rmk_abc --quality 720p --yes --wait                                  # charged: films it`,
    );

  const start = remake
    .command("start", { isDefault: true })
    .description("study an ad and write its remake (free; the default: `scrolling remake …`)")
    .option("--brand <brd_id>", "the brand it is for (required)")
    .option("--video <url|file|file_id>", "the ad: a TikTok/Reels/Shorts/FB/X link, a local file or a file id (required)")
    .option("--note <text>", "what the remake should sell or change")
    .option("--creator <cr_id>", "who says it, in order (default: the brand's usual Creator)", idList)
    .option("--product <prd_id>", "the product it is about (default: our best pick)")
    .option("--sells <what>", "product (default) or brand (no product in it)")
    .option("--idempotency-key <key>", "reuse the key of an earlier run to retry it safely");
  withWaitOptions(start);
  start.action(
    act(ctx, async (rt, _a, o) => {
      if (!o.brand || !o.video) throw usageError("A Remake needs --brand and --video. See: scrolling remake --help");
      if (o.sells && o.sells !== "product" && o.sells !== "brand") throw usageError("--sells is product or brand.");
      const api = await rt.api();
      const body = compact({
        brand_id: o.brand,
        ...(await videoSource(rt, api, o.video as string)),
        note: o.note,
        creator_ids: o.creator,
        product_id: o.product,
        sells: o.sells,
      });
      await startJob(rt, api, "/remakes", body, o);
    }),
  );

  const film = remake
    .command("film")
    .description("film a Remake's script (charged)")
    .argument("<rmk_id>", "the Remake, once its script is written")
    .option("--quality <q>", "480p (default), 720p or 1080p", qualityArg());
  withSpendOptions(film);
  withWaitOptions(film);
  film.action(
    act(ctx, async (rt, [id], o) => {
      const api = await rt.api();
      await startJob(rt, api, `/remakes/${encodeURIComponent(id)}/film`, compact({ job_id: id, quality: o.quality }), o, compact({ kind: "remake_film" as const, job_id: id, quality: o.quality }) as { kind: "remake_film" });
    }),
  );
}
