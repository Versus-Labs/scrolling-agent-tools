import type { Command } from "commander";
import { estimate, type Estimate, type EstimateInput } from "../confirm.js";
import type { Context } from "../context.js";
import { usageError } from "../exit-codes.js";
import type { Runtime } from "../runtime.js";
import { formatEstimate } from "./format.js";
import { act, compact, intArg, lengthArg, qualityArg, videoSource } from "./shared.js";

async function show(rt: Runtime, input: EstimateInput): Promise<void> {
  const api = await rt.api();
  const e = await estimate(api, compact(input) as EstimateInput);
  rt.out.result(e, { human: formatEstimate, quiet: (x: Estimate) => String(x.credits) });
}

export function registerCost(program: Command, ctx: Context): void {
  const cost = program
    .command("cost")
    .description("what something costs, before you start it (nothing is spent)")
    .addHelpText(
      "after",
      `
Examples:
  $ scrolling cost create --length 30 --quality 720p
  $ scrolling cost swap --video https://www.tiktok.com/@shop/video/123 --seconds 20
  $ scrolling cost swap-hd swp_abc123 --version 2`,
    );

  cost
    .command("create")
    .description("a new video")
    .requiredOption("--length <seconds>", "15, 20, 30 or 60", lengthArg)
    .option("--quality <q>", "480p (default), 720p or 1080p", qualityArg())
    .action(act(ctx, (rt, _a, o) => show(rt, { kind: "video", length_seconds: o.length, quality: o.quality })));

  cost
    .command("swap")
    .description("a Swap (give --seconds, or the --video to measure)")
    .option("--seconds <n>", "seconds to swap (4–120)", intArg("--seconds", 4, 120))
    .option("--video <file|url|file_id>", "the video (a local file is uploaded to measure it)")
    .option("--quality <q>", "480p (default), 720p or 1080p", qualityArg())
    .action(
      act(ctx, async (rt, _a, o) => {
        if (o.seconds === undefined && !o.video) throw usageError("Give --seconds or --video.");
        const src = o.seconds === undefined && o.video ? await videoSource(rt, await rt.api(), o.video as string) : {};
        await show(rt, { kind: "swap", seconds: o.seconds, ...src, quality: o.quality });
      }),
    );

  cost
    .command("swap-redo")
    .description("a new draft of a Swap")
    .argument("<swp_id>", "the Swap")
    .option("--quality <q>", "480p or 720p", qualityArg(["480p", "720p"]))
    .action(act(ctx, (rt, [id], o) => show(rt, { kind: "swap_redo", job_id: id, quality: o.quality })));

  cost
    .command("swap-hd")
    .description("finishing a Swap's version in 1080p")
    .argument("<swp_id>", "the Swap")
    .requiredOption("--version <n>", "which version", intArg("--version", 1, 1000))
    .action(act(ctx, (rt, [id], o) => show(rt, { kind: "swap_hd", job_id: id, version: o.version })));

  cost
    .command("remake-film")
    .description("filming a Remake's script")
    .argument("<rmk_id>", "the Remake")
    .option("--quality <q>", "480p (default), 720p or 1080p", qualityArg())
    .action(act(ctx, (rt, [id], o) => show(rt, { kind: "remake_film", job_id: id, quality: o.quality })));
}
