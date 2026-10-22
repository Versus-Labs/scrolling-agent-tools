import { CliError, EXIT } from "./exit-codes.js";
import { ApiError, type Api } from "./http.js";
import type { Runtime } from "./runtime.js";

/**
 * Consent before credits are spent. Every spending command asks POST /estimates first, then:
 *   --max-credits N  goes ahead when the price is at most N;
 *   --yes            goes ahead at the estimated price;
 *   a terminal       shows the price and asks;
 *   otherwise        prints the estimate on stdout and exits 9, so an agent can show the price
 *                    to its person and run the command again with --yes.
 * The quote_id makes the shown price the most charged (a video that costs less gets the rest back). A 428 from the server (a quote that
 * expired meanwhile) goes through the same gate once more with the server's fresh estimate, but
 * --yes only ever consents to what was shown: a fresh price above the one first accepted is exit
 * 9 with the new estimate (--max-credits N still goes ahead up to N; a terminal asks again).
 */

export type Estimate = {
  quote_id: string;
  credits: number;
  balance: number;
  balance_after: number;
  enough: boolean;
  monthly_cap_left: number | null;
  expires_at: string;
  later?: { hd_credits: number };
  next_step: string;
};

export type EstimateInput = { kind: "video" | "swap" | "swap_redo" | "swap_hd" | "remake_film" | "creator" } & Record<string, unknown>;
export type Consent = { quote_id?: string; max_credits?: number };
export type SpendFlags = { maxCredits?: number; idempotencyKey?: string };

export type StartedJob = {
  job_id: string;
  /** creator: job_id is the new Creator's cr_… id. */
  kind: "render" | "swap" | "remake" | "creator";
  status: string;
  credits_held: number;
  replayed: boolean;
  estimated_seconds: number;
  poll_after_seconds: number;
  watch_url: string;
  next_step: string;
};

export function describeEstimate(e: Estimate): string {
  const lines = [`This costs at most ${e.credits} credits; what it doesn't use comes back. Balance: ${e.balance} → ${e.balance_after} after.`];
  if (e.later?.hd_credits) lines.push(`Finishing it in 1080p later costs ${e.later.hd_credits} more.`);
  if (e.monthly_cap_left !== null && e.monthly_cap_left !== undefined) lines.push(`This login may spend ${e.monthly_cap_left} more credits this month.`);
  if (!e.enough) lines.push("The account doesn't have enough credits for this.");
  return lines.join("\n");
}

/** Prints the estimate as the command's result and returns the exit-9 error. */
function confirmationRequired(rt: Runtime, e: Estimate, why: string): CliError {
  rt.out.result(
    { confirmation_required: true, estimate: e, next: "Show the price to the person. If they agree, run the same command again with --yes (or --max-credits N)." },
    { human: () => `${describeEstimate(e)}\nNot started: ${why}. Run it again with --yes to go ahead.` },
  );
  return new CliError(`Not started: ${why}. Confirm the price with --yes (or --max-credits ${e.credits}).`, EXIT.confirm, "confirmation_required", { credits: e.credits });
}

/** The consent to send with a spending call for this estimate (or the exit-9 error). */
export async function consentFor(rt: Runtime, e: Estimate, flags: SpendFlags): Promise<Consent> {
  if (flags.maxCredits !== undefined) {
    if (e.credits <= flags.maxCredits) return { quote_id: e.quote_id, max_credits: flags.maxCredits };
    throw confirmationRequired(rt, e, `it costs ${e.credits} credits, more than --max-credits ${flags.maxCredits}`);
  }
  if (rt.opts.yes) return { quote_id: e.quote_id };
  if (rt.out.interactive(rt.opts)) {
    rt.ctx.stderr.write(describeEstimate(e) + "\n");
    const answer = (await rt.ctx.prompt("Go ahead? [y/N] ", rt.ctx.signal)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") return { quote_id: e.quote_id };
    throw new CliError("Not started.", EXIT.confirm, "declined");
  }
  throw confirmationRequired(rt, e, "the price wasn't confirmed");
}

export async function estimate(api: Api, input: EstimateInput): Promise<Estimate> {
  return api.post<Estimate>("/estimates", input);
}

function estimateFromError(e: unknown): Estimate | null {
  if (!(e instanceof ApiError) || e.code !== "confirmation_required") return null;
  const est = e.details?.estimate as Estimate | undefined;
  return est && typeof est.quote_id === "string" && typeof est.credits === "number" ? est : null;
}

/**
 * Starts something that may spend credits: estimate (when `estimateInput` is given) → consent →
 * POST with an Idempotency-Key (yours, or a new uuid kept for every retry of this run). Without
 * an estimate (something free) it consents to 0 credits only.
 */
export async function spend(
  rt: Runtime,
  api: Api,
  path: string,
  body: Record<string, unknown>,
  o: { estimateInput?: EstimateInput; flags: SpendFlags },
): Promise<StartedJob & { idempotency_key: string }> {
  const key = o.flags.idempotencyKey ?? rt.ctx.randomUUID();
  const first = o.estimateInput ? await estimate(api, o.estimateInput) : null;
  // The credits the person (or --yes) agreed to: the estimate shown, or 0 for something free.
  const accepted = first ? first.credits : 0;
  let consent: Consent = first ? await consentFor(rt, first, o.flags) : { max_credits: o.flags.maxCredits ?? 0 };
  for (let attempt = 0; ; attempt++) {
    try {
      const started = await api.post<StartedJob>(path, { ...body, ...consent, idempotency_key: key }, { idempotencyKey: key });
      return { ...started, idempotency_key: key };
    } catch (e) {
      const fresh = estimateFromError(e);
      if (!fresh || attempt > 0) {
        if (fresh) throw confirmationRequired(rt, fresh, "the price changed");
        throw e;
      }
      // --yes consented to the price shown, not to whatever it is now (--max-credits has its own ceiling).
      if (rt.opts.yes && o.flags.maxCredits === undefined && fresh.credits > accepted) {
        throw confirmationRequired(rt, fresh, `the price changed from ${accepted} to ${fresh.credits} credits`);
      }
      consent = await consentFor(rt, fresh, o.flags);
    }
  }
}
