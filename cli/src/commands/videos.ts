import { basename, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Command } from "commander";
import { isLoopbackHost } from "../config.js";
import type { Context } from "../context.js";
import { CliError, EXIT, usageError } from "../exit-codes.js";
import { errorFromResponse, send, userAgent } from "../http.js";
import type { Runtime } from "../runtime.js";
import { followHttps } from "../upload.js";
import { formatVideos } from "./format.js";
import { act, intArg } from "./shared.js";

type DownloadLink = { id: string; version: number | null; url: string; expires_at: string; expires_in_sec: number };

/** Download links are https (or our own loopback origin in local development). */
function checkDownloadUrl(rt: Runtime, raw: string): string {
  const u = new URL(raw);
  if (u.protocol === "https:") return u.toString();
  if (u.protocol === "http:" && isLoopbackHost(u.hostname) && u.origin === rt.settings.apiUrl) return u.toString();
  throw new CliError("Refusing to download over an unencrypted connection.", EXIT.error, "unsafe_url");
}

async function download(rt: Runtime, link: DownloadLink, output: string, force: boolean): Promise<number> {
  if (!force && rt.ctx.fs.existsSync(output)) throw usageError(`${output} already exists (use --force to replace it).`);
  let target = checkDownloadUrl(rt, link.url);
  let res: Response | null = null;
  for (let hop = 0; hop <= 3; hop++) {
    res = await send(rt.ctx, rt.out, target, { headers: { "User-Agent": userAgent(rt.ctx) }, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) break;
    await res.body?.cancel().catch(() => {});
    target = followHttps(target, res.headers.get("location"));
    res = null;
  }
  if (!res) throw new CliError("The download was redirected too many times.", EXIT.error, "bad_redirect");
  if (!res.ok || !res.body) throw await errorFromResponse(res);
  const tmp = `${output}.part`;
  let bytes = 0;
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  body.on("data", (c: Buffer) => {
    bytes += c.length;
  });
  await pipeline(body, rt.ctx.fs.createWriteStream(tmp, { mode: 0o644 }), { signal: rt.ctx.signal });
  rt.ctx.fs.renameSync(tmp, output);
  return bytes;
}

export function registerVideos(program: Command, ctx: Context): void {
  const videos = program.command("videos").description("finished videos (vid_…, swp_…)");
  videos
    .command("list")
    .description("list finished videos, newest first")
    .option("--brand <brd_id>", "only this brand's")
    .option("--limit <n>", "how many (1–50, default 20)", intArg("--limit", 1, 50))
    .option("--cursor <cursor>", "the next page (next_cursor of the previous one)")
    .action(
      act(ctx, async (rt, _args, o) => {
        const api = await rt.api();
        const d = await api.get<Parameters<typeof formatVideos>[0]>("/videos", { query: { brand_id: o.brand as string | undefined, limit: o.limit as number | undefined, cursor: o.cursor as string | undefined } });
        rt.out.result(d, { human: formatVideos, quiet: (v) => v.videos.map((x) => x.id).join("\n") });
      }),
    );

  videos
    .command("download")
    .description("download a finished video (or just print its link with --link-only)")
    .argument("<id>", "vid_… or swp_…")
    .option("--version <n>", "a Swap's version (default: its newest finished one)", intArg("--version", 1, 1000))
    .option("-o, --output <path>", "where to save it (default: <id>.mp4 here)")
    .option("--force", "replace the file if it exists")
    .option("--link-only", "print a signed download link (valid for a while) instead of downloading")
    .addHelpText("after", "\nExamples:\n  $ scrolling videos download vid_abc123\n  $ scrolling videos download swp_abc123 --version 2 -o final.mp4")
    .action(
      act(ctx, async (rt, [id], o) => {
        const api = await rt.api();
        const link = await api.get<DownloadLink>(`/videos/${encodeURIComponent(id)}/download`, { query: { version: o.version as number | undefined } });
        if (o.linkOnly) {
          rt.out.result(link, { quiet: (l) => l.url });
          return;
        }
        const output = resolve((o.output as string | undefined) ?? `${basename(id)}${link.version ? `-v${link.version}` : ""}.mp4`);
        rt.out.info(`Downloading ${id} → ${output}`);
        const bytes = await download(rt, link, output, !!o.force);
        rt.out.result({ id: link.id, version: link.version, path: output, bytes }, { human: (r) => `Saved ${r.path} (${(r.bytes / 1_048_576).toFixed(1)} MB).`, quiet: (r) => r.path });
      }),
    );
}
