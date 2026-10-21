import { isAbort } from "./context.js";
import { CliError, EXIT } from "./exit-codes.js";
import type { Api } from "./http.js";
import type { Runtime } from "./runtime.js";

/**
 * Following a job: GET /jobs/:id?wait=40 (the server holds the request until the job finishes
 * or moves on), progress on stderr, until it finishes (exit 0), fails or is cancelled (8), or
 * the timeout passes (7, with the command to resume). Ctrl-C stops waiting (130); the job keeps
 * running either way: never start it again to check on it.
 */

export type Job = {
  id: string;
  kind: "render" | "swap" | "remake";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  step: number;
  steps: number;
  headline: string;
  error: string | null;
  stage?: string;
  video?: { watch_url: string | null } | null;
  [k: string]: unknown;
};
export type WaitOutput = { job: Job; poll_after_seconds: number; next_step: string };

export const WAIT_SECONDS = 40;
export const DEFAULT_TIMEOUT_S = 15 * 60;

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function progressLine(j: Job): string {
  const pct = j.status === "running" || j.status === "queued" ? `  ${j.progress}%` : "";
  const stage = j.stage ? ` (${j.stage})` : "";
  return `${j.id}  ${j.status}${stage}${pct}  ${j.headline}`.trimEnd();
}

export const resumeCommand = (id: string) => `scrolling jobs wait ${id}`;

export async function waitForJob(rt: Runtime, api: Api, id: string, o: { timeoutSec?: number } = {}): Promise<WaitOutput> {
  const timeout = o.timeoutSec ?? DEFAULT_TIMEOUT_S;
  const deadline = rt.ctx.now() + timeout * 1000;
  let last = "";
  for (;;) {
    const remaining = deadline - rt.ctx.now();
    const wait = Math.max(0, Math.min(WAIT_SECONDS, Math.floor(remaining / 1000)));
    const asked = rt.ctx.now();
    let res: WaitOutput;
    try {
      res = await api.get<WaitOutput>(`/jobs/${encodeURIComponent(id)}`, { query: { wait } });
    } catch (e) {
      if (isAbort(e)) {
        rt.out.progressDone();
        throw new CliError(`Stopped waiting. The job keeps running; resume with: ${resumeCommand(id)}`, EXIT.interrupted, "interrupted", { job_id: id, next: resumeCommand(id) });
      }
      throw e;
    }
    const job = res.job;
    const line = progressLine(job);
    if (line !== last) {
      rt.out.progress(line);
      last = line;
    }
    if (TERMINAL.has(job.status)) {
      rt.out.progressDone();
      if (job.status === "succeeded") return res;
      rt.out.result(res);
      throw new CliError(job.error ?? `The job ${job.status === "cancelled" ? "was cancelled" : "failed"}.`, EXIT.jobFailed, job.status === "cancelled" ? "job_cancelled" : "job_failed", { job_id: id });
    }
    if (rt.ctx.now() >= deadline) {
      rt.out.progressDone();
      rt.out.result({ ...res, next: resumeCommand(id) });
      throw new CliError(`Still running after ${timeout} s. It keeps going; resume with: ${resumeCommand(id)}`, EXIT.stillRunning, "still_running", { job_id: id, next: resumeCommand(id) });
    }
    // A server that answered at once without news (no long-poll): wait as it asks before the next look.
    if (rt.ctx.now() - asked < 1000) {
      const pause = Math.min(Math.max(1, res.poll_after_seconds || 5) * 1000, Math.max(0, deadline - rt.ctx.now()));
      try {
        await rt.ctx.sleep(pause, rt.ctx.signal);
      } catch (e) {
        if (isAbort(e)) {
          rt.out.progressDone();
          throw new CliError(`Stopped waiting. The job keeps running; resume with: ${resumeCommand(id)}`, EXIT.interrupted, "interrupted", { job_id: id, next: resumeCommand(id) });
        }
        throw e;
      }
    }
  }
}
