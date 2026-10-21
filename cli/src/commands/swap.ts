import type { Command } from "commander";
import type { Context } from "../context.js";
import { usageError } from "../exit-codes.js";
import { act, compact, fileIds, idList, intArg, many, qualityArg, startJob, videoSource, withSpendOptions, withWaitOptions } from "./shared.js";

const KINDS = ["person", "product", "both", "background"];

export function registerSwap(program: Command, ctx: Context): void {
  const swap = program
    .command("swap")
    .description("Swap: put your Creators, product or place into an existing video")
    .addHelpText(
      "after",
      `
Examples:
  $ scrolling swap --brand brd_abc --kind person --video https://www.tiktok.com/@shop/video/123 --seconds 20 --creator cr_mei --yes --wait
  $ scrolling swap --brand brd_abc --kind product --video ./ad.mp4 --product prd_xyz --json
  $ scrolling swap revise swp_abc --note "Make her smile more"
  $ scrolling swap approve swp_abc --version 2 --quality 1080p --yes`,
    );

  const start = swap
    .command("start", { isDefault: true })
    .description("start a Swap (the default: `scrolling swap …`)")
    .option("--brand <brd_id>", "the brand it is for (required)")
    .option("--kind <kind>", "person, product, both or background (required)")
    .option("--video <file|url|file_id>", "the video: a TikTok/Reels/Shorts/FB/X link, a .mp4/.mov link, a local file, or a file id (required)")
    .option("--seconds <n>", "seconds to swap and pay for, from the start (4–120; needed for platform links)", intArg("--seconds", 4, 120))
    .option("--creator <cr_id>", "who goes in, in order (repeat or comma-separate)", idList)
    .option("--product <prd_id>", "the brand's product that goes in")
    .option("--product-photo <file|url|file_id>", "a photo of the product (repeat)", many)
    .option("--product-title <text>", "the product's name")
    .option("--scene <preset>", "background swaps: kitchen, living, bedroom, bathroom, office, gym, street, park, beach, car…")
    .option("--scene-text <text>", "background swaps: the place in words")
    .option("--place-photo <file|url|file_id>", "background swaps: a photo of the place (repeat)", many)
    .option("--keep-voice", "one Creator: keep the original voice")
    .option("--keep-outfit", "person swaps: only face and hair change")
    .option("--note <text>", "anything else to change, in your words")
    .option("--quality <q>", "480p (default), 720p, or 1080p (finished on approval, charged then)", qualityArg())
    .option("--title <text>", "the name on the Swap board");
  withSpendOptions(start);
  withWaitOptions(start);
  start.action(
    act(ctx, async (rt, _a, o) => {
      if (!o.brand || !o.kind || !o.video) throw usageError("A Swap needs --brand, --kind and --video. See: scrolling swap --help");
      if (!KINDS.includes(o.kind as string)) throw usageError(`--kind is one of ${KINDS.join(", ")}.`);
      const api = await rt.api();
      const video = await videoSource(rt, api, o.video as string);
      const scene = o.scene || o.sceneText ? compact({ preset: o.scene, text: o.sceneText }) : undefined;
      const body = compact({
        brand_id: o.brand,
        kind: o.kind,
        ...video,
        seconds: o.seconds,
        creator_ids: o.creator,
        product_id: o.product,
        product_photo_file_ids: await fileIds(rt, api, o.productPhoto as string[] | undefined),
        product_title: o.productTitle,
        scene,
        place_photo_file_ids: await fileIds(rt, api, o.placePhoto as string[] | undefined),
        keep_voice: o.keepVoice ? true : undefined,
        keep_outfit: o.keepOutfit ? true : undefined,
        note: o.note,
        quality: o.quality,
        title: o.title,
      });
      const estimateInput = compact({ kind: "swap" as const, ...(o.seconds !== undefined ? { seconds: o.seconds } : video), quality: o.quality });
      await startJob(rt, api, "/swaps", body, o, estimateInput as { kind: "swap" });
    }),
  );

  const revise = swap
    .command("revise")
    .description("a new draft of a Swap, with your note (charged)")
    .argument("<swp_id>", "the Swap")
    .requiredOption("--note <text>", "what to change")
    .option("--quality <q>", "480p or 720p", qualityArg(["480p", "720p"]));
  withSpendOptions(revise);
  withWaitOptions(revise);
  revise.action(
    act(ctx, async (rt, [id], o) => {
      const api = await rt.api();
      const body = compact({ job_id: id, action: "redo", note: o.note, quality: o.quality });
      await startJob(rt, api, `/swaps/${encodeURIComponent(id)}/revise`, body, o, compact({ kind: "swap_redo" as const, job_id: id, quality: o.quality }) as { kind: "swap_redo" });
    }),
  );

  const approve = swap
    .command("approve")
    .description("keep a version (480p/720p: free) or finish it in 1080p (charged)")
    .argument("<swp_id>", "the Swap")
    .requiredOption("--version <n>", "which version", intArg("--version", 1, 1000))
    .option("--quality <q>", "480p, 720p or 1080p", qualityArg());
  withSpendOptions(approve);
  withWaitOptions(approve);
  approve.action(
    act(ctx, async (rt, [id], o) => {
      const api = await rt.api();
      const body = compact({ job_id: id, action: "approve", version: o.version, quality: o.quality });
      // 1080p is charged: estimate first. Otherwise it is free (consent to 0 credits; a 428 brings the price).
      const estimateInput = o.quality === "1080p" ? { kind: "swap_hd" as const, job_id: id, version: o.version } : undefined;
      await startJob(rt, api, `/swaps/${encodeURIComponent(id)}/revise`, body, o, estimateInput);
    }),
  );
}
