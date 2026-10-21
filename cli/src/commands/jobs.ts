import type { Command } from "commander";
import type { Context } from "../context.js";
import { CliError, EXIT } from "../exit-codes.js";
import { waitForJob, type WaitOutput } from "../wait.js";
import { formatWait } from "./format.js";
import { act, intArg } from "./shared.js";

type CancelOutput = { job_id: string; status: "cancelled"; credits_refunded: number; credits_kept: number };

export function registerJobs(program: Command, ctx: Context): void {
  const jobs = program
    .command("jobs")
    .description("follow what you started: job_… (a video being filmed), swp_… (a Swap), rmk_… (a Remake)")
    .addHelpText(
      "after",
      `
Examples:
  $ scrolling jobs get job_abc123
  $ scrolling jobs wait job_abc123 --timeout 1200     # exit 0 done, 7 still running, 8 failed
  $ scrolling jobs cancel job_abc123 --yes`,
    );

  jobs
    .command("get")
    .description("where a job is now")
    .argument("<id>", "job_…, swp_… or rmk_…")
    .action(
      act(ctx, async (rt, [id]) => {
        const api = await rt.api();
        const d = await api.get<WaitOutput>(`/jobs/${encodeURIComponent(id)}`, { query: { wait: 0 } });
        rt.out.result(d, { human: formatWait, quiet: (x) => x.job.status });
      }),
    );

  jobs
    .command("wait")
    .description("wait until a job finishes (progress on stderr); safe to run again")
    .argument("<id>", "job_…, swp_… or rmk_…")
    .option("--timeout <seconds>", "stop waiting after this long (default 900; exit 7)", intArg("--timeout", 1, 86_400))
    .action(
      act(ctx, async (rt, [id], o) => {
        const api = await rt.api();
        const d = await waitForJob(rt, api, id, { timeoutSec: o.timeout as number | undefined });
        rt.out.result(d, { human: formatWait, quiet: (x) => x.job.status });
      }),
    );

  jobs
    .command("cancel")
    .description("stop a video being filmed (job_…) and get back what it hasn't used")
    .argument("<id>", "job_…")
    .action(
      act(ctx, async (rt, [id]) => {
        if (!rt.opts.yes) {
          if (!rt.out.interactive(rt.opts)) throw new CliError(`Cancelling ${id} needs --yes.`, EXIT.confirm, "confirmation_required", { job_id: id });
          const answer = (await rt.ctx.prompt(`Cancel ${id}? [y/N] `, rt.ctx.signal)).trim().toLowerCase();
          if (answer !== "y" && answer !== "yes") throw new CliError("Not cancelled.", EXIT.confirm, "declined");
        }
        const api = await rt.api();
        const d = await api.delete<CancelOutput>(`/jobs/${encodeURIComponent(id)}`);
        rt.out.result(d, { human: (x) => `Cancelled ${x.job_id}: ${x.credits_refunded} credits back, ${x.credits_kept} kept for work already done.` });
      }),
    );
}
