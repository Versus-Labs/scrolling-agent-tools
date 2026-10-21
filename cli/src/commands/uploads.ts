import type { Command } from "commander";
import type { Context } from "../context.js";
import { importUrl, isFileId, isUrl, uploadFile, type FileOutput } from "../upload.js";
import { usageError } from "../exit-codes.js";
import { act } from "./shared.js";

export function registerUploads(program: Command, ctx: Context): void {
  const uploads = program.command("uploads").description("files for Swaps, Remakes and references (file ids last 7 days)");
  uploads
    .command("add")
    .description("upload a local file, or import a public https link, and print its file id (u1.…)")
    .argument("<file-or-url>", "a local picture/video, or an https link straight to one")
    .option("--kind <kind>", "for links: image or video (default: from the file)")
    .option("--name <name>", "for links: the name to keep")
    .addHelpText(
      "after",
      `
Other commands take a path or link directly and upload it for you; use this to reuse a file.

Examples:
  $ scrolling uploads add ./clip.mp4
  $ scrolling uploads add https://example.com/photo.jpg --json`,
    )
    .action(
      act(ctx, async (rt, [ref], o) => {
        if (isFileId(ref)) throw usageError("That is already a file id.");
        const kind = o.kind as string | undefined;
        if (kind && kind !== "image" && kind !== "video") throw usageError("--kind is image or video.");
        const api = await rt.api();
        const f: FileOutput = isUrl(ref) ? await importUrl(api, ref, { kind: kind as "image" | "video" | undefined, name: o.name as string | undefined }) : await uploadFile(rt, api, ref);
        rt.out.result(f, { quiet: (x) => x.file_id });
      }),
    );
}
