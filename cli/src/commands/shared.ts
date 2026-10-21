import { InvalidArgumentError, type Command } from "commander";
import type { Context } from "../context.js";
import { spend, type EstimateInput, type SpendFlags, type StartedJob } from "../confirm.js";
import type { Api } from "../http.js";
import { createRuntime, type Runtime } from "../runtime.js";
import { fileIdOf, isUrl } from "../upload.js";
import { waitForJob, type WaitOutput } from "../wait.js";
import { formatStarted, formatWait } from "./format.js";

/** Runs an action with a Runtime built from the global and local flags. Operands come first. */
export function act(ctx: Context, fn: (rt: Runtime, args: string[], opts: Record<string, unknown>) => Promise<void>) {
  return async (...all: unknown[]) => {
    const cmd = all[all.length - 1] as Command;
    const opts = cmd.optsWithGlobals();
    const operands = all.slice(0, cmd.registeredArguments.length) as string[];
    await fn(createRuntime(ctx, opts), operands, cmd.opts());
  };
}

export function intArg(name: string, min: number, max: number) {
  return (raw: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new InvalidArgumentError(`${name} must be a whole number from ${min} to ${max}.`);
    return n;
  };
}

/** Repeatable option; ids may also be comma-separated (--creator cr_a,cr_b). */
export function idList(value: string, previous: string[] = []): string[] {
  return [...previous, ...value.split(",").map((s) => s.trim()).filter(Boolean)];
}

/** Repeatable option, one value each (paths may contain commas). */
export function many(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function jsonArg(name: string) {
  return (raw: string): Record<string, unknown> => {
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* below */
    }
    throw new InvalidArgumentError(`${name} must be a JSON object, e.g. '{"captions":true}'.`);
  };
}

export const QUALITIES = ["480p", "720p", "1080p"] as const;
export const VIDEO_LENGTHS = ["15", "20", "30", "60"] as const;

/** --max-credits and --idempotency-key (and --yes, which is global). */
export function withSpendOptions(cmd: Command): Command {
  return cmd
    .option("--max-credits <n>", "go ahead without asking when it costs at most n credits", intArg("--max-credits", 0, 1_000_000))
    .option("--idempotency-key <key>", "reuse the key of an earlier run to retry it safely (default: a new one per run)");
}

export function withWaitOptions(cmd: Command): Command {
  return cmd.option("--wait", "wait for the job to finish (progress on stderr)").option("--timeout <seconds>", "with --wait: stop waiting after this long (exit 7)", intArg("--timeout", 1, 86_400));
}

export function spendFlags(o: Record<string, unknown>): SpendFlags {
  return { maxCredits: o.maxCredits as number | undefined, idempotencyKey: o.idempotencyKey as string | undefined };
}

/** Starts a job (estimate → consent → POST), prints it, and with --wait follows it to the end. */
export async function startJob(rt: Runtime, api: Api, path: string, body: Record<string, unknown>, o: Record<string, unknown>, estimateInput?: EstimateInput): Promise<void> {
  const started = await spend(rt, api, path, body, { estimateInput, flags: spendFlags(o) });
  if (!o.wait) {
    rt.out.result(started, { human: formatStarted, quiet: (s) => s.job_id });
    return;
  }
  rt.out.info(`Started ${started.job_id}${started.replayed ? " (already started earlier with this key; nothing charged again)" : ""}. Waiting for it…`);
  const done = await waitForJob(rt, api, started.job_id, { timeoutSec: o.timeout as number | undefined });
  rt.out.result({ started, ...done } as { started: StartedJob } & WaitOutput, { human: (d) => formatWait(d), quiet: (d) => d.job.id });
}

/** A video argument: links (TikTok, Reels, Shorts, FB, X, .mp4) pass through; a file id as is; a local file is uploaded. */
export async function videoSource(rt: Runtime, api: Api, ref: string): Promise<{ video_url?: string; video_file_id?: string }> {
  if (isUrl(ref)) return { video_url: ref };
  return { video_file_id: await fileIdOf(rt, api, ref) };
}

/** Each file argument as a file id (uploading or importing what needs it). */
export async function fileIds(rt: Runtime, api: Api, refs: readonly string[] | undefined): Promise<string[] | undefined> {
  if (!refs?.length) return undefined;
  const out: string[] = [];
  for (const r of refs) out.push(await fileIdOf(rt, api, r));
  return out;
}

export function lengthArg(raw: string): number {
  if (!(VIDEO_LENGTHS as readonly string[]).includes(raw)) throw new InvalidArgumentError(`--length is one of ${VIDEO_LENGTHS.join(", ")} (seconds).`);
  return Number(raw);
}

export function qualityArg(allowed: readonly string[] = QUALITIES) {
  return (raw: string): string => {
    if (!allowed.includes(raw)) throw new InvalidArgumentError(`--quality is one of ${allowed.join(", ")}.`);
    return raw;
  };
}

/** Drops undefined fields (so the JSON body has only what was given). */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
