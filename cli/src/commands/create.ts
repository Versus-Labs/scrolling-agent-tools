import type { Command } from "commander";
import type { Context } from "../context.js";
import { usageError } from "../exit-codes.js";
import { act, compact, fileIds, idList, jsonArg, lengthArg, many, qualityArg, startJob, withSpendOptions, withWaitOptions } from "./shared.js";

type ScriptOutput = { idea: string; script: string; comment: { text: string; handle: string } | null; words: number; next_step: string };

export function registerCreate(program: Command, ctx: Context): void {
  const create = program
    .command("create")
    .description("make a video with your Creators (asks to confirm the price first)")
    .requiredOption("--brand <brd_id>", "the brand it is for")
    .requiredOption("--creator <cr_id>", "a Creator, in order (repeat or comma-separate; Creator 1 first)", idList)
    .requiredOption("--length <seconds>", "15, 20, 30 or 60", lengthArg)
    .option("--idea <text>", 'what happens: place, people, actions, product, mood ("@Mei", "@Product 1"); only words in "double quotes" are spoken')
    .option("--script <text>", "the exact words to say (e.g. from --write-only)")
    .option("--script-file <path>", "read the words to say from a file")
    .option("--style <id>", "a style, e.g. ugc-talk, unboxing, review, before-after, tier-list, free")
    .option("--product <prd_id>", "a product it is about (repeat; @Product 1 first)", idList)
    .option("--quality <q>", "480p (default), 720p or 1080p", qualityArg())
    .option("--reference <file|url|file_id>", "a picture or video to follow (repeat; @Reference 1 first)", many)
    .option("--options <json>", 'advanced options as JSON: pace, delivery, captions, accent, music, ambience, endCard, comment, graphics', jsonArg("--options"))
    .option("--write-only", "only write the idea and script (free); film it later with --script");
  withSpendOptions(create);
  withWaitOptions(create);
  create.addHelpText(
    "after",
    `
Examples:
  $ scrolling create --brand brd_abc --creator cr_mei --length 30 --idea 'Mei unboxes @Product 1 in her kitchen' --product prd_xyz --write-only
  $ scrolling create --brand brd_abc --creator cr_mei --length 30 --idea '…' --script-file script.txt --yes --wait
  $ scrolling create … --max-credits 400 --json      # agents: go ahead only up to 400 credits

Without --yes (or --max-credits) and without a terminal, nothing is spent: the estimate is
printed and the exit code is 9. Show the price, then run the same command with --yes.`,
  );
  create.action(
    act(ctx, async (rt, _a, o) => {
      if (o.script && o.scriptFile) throw usageError("Give --script or --script-file, not both.");
      let script = o.script as string | undefined;
      if (o.scriptFile) {
        try {
          script = rt.ctx.fs.readFileSync(o.scriptFile as string, "utf8").trim();
        } catch {
          throw usageError(`Can't read ${o.scriptFile as string}.`);
        }
      }
      const options = o.options as Record<string, unknown> | undefined;
      const api = await rt.api();
      if (o.writeOnly) {
        const body = compact({
          brand_id: o.brand,
          creator_ids: o.creator,
          product_ids: o.product,
          idea: o.idea,
          style: o.style,
          length_seconds: o.length,
          comment: options?.comment,
        });
        const s = await api.post<ScriptOutput>("/scripts", body);
        rt.out.result(s, { human: (x) => `Idea:\n${x.idea}\n\nScript (${x.words} words):\n${x.script}\n\nNext: ${x.next_step}`, quiet: (x) => x.script });
        return;
      }
      if (!o.idea) throw usageError("Say what happens in the video with --idea (or use --write-only to have it written).");
      const references = await fileIds(rt, api, o.reference as string[] | undefined);
      const body = compact({
        brand_id: o.brand,
        creator_ids: o.creator,
        product_ids: o.product,
        idea: o.idea,
        script,
        style: o.style,
        length_seconds: o.length,
        quality: o.quality,
        options,
        reference_file_ids: references,
      });
      await startJob(rt, api, "/create", body, o, compact({ kind: "video" as const, length_seconds: o.length, quality: o.quality }) as { kind: "video" });
    }),
  );
}
