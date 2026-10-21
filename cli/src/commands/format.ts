import type { Estimate, StartedJob } from "../confirm.js";
import { describeEstimate } from "../confirm.js";
import { table } from "../output.js";
import { progressLine, resumeCommand, type WaitOutput } from "../wait.js";

/** Terminal text for the main results (JSON output is always the server's shape). */

const dash = (v: unknown) => (v === null || v === undefined || v === "" ? "-" : String(v));

export function formatStarted(s: StartedJob & { idempotency_key?: string }): string {
  const lines = [
    `${s.replayed ? "Already started (same idempotency key; nothing charged again)" : "Started"}: ${s.job_id} (${s.kind})`,
    `Credits held: ${s.credits_held}. Usually takes about ${Math.max(1, Math.round(s.estimated_seconds / 60))} min.`,
    `Watch it: ${s.watch_url}`,
    `Follow it: ${resumeCommand(s.job_id)}`,
  ];
  return lines.join("\n");
}

export function formatWait(d: WaitOutput & { started?: StartedJob }): string {
  const j = d.job;
  const lines = [progressLine(j)];
  if (j.error) lines.push(`Error: ${j.error}`);
  const video = j.video as { watch_url?: string | null; id?: string } | null | undefined;
  if (video?.watch_url) lines.push(`Watch: ${video.watch_url}`);
  if (video?.id) lines.push(`Download: scrolling videos download ${video.id}`);
  const script = j.script as { lines?: { text: string }[] } | null | undefined;
  if (script?.lines?.length) lines.push("Script:", ...script.lines.map((l) => `  ${l.text}`));
  if (d.next_step) lines.push(`Next: ${d.next_step}`);
  return lines.join("\n");
}

export function formatEstimate(e: Estimate): string {
  return `${describeEstimate(e)}\nQuote ${e.quote_id.slice(0, 10)}… holds this price until ${e.expires_at}.`;
}

type Brand = { id: string; name: string; kind: string; website: string | null };

export function formatBrands(d: { brands: Brand[] }): string {
  return table(
    d.brands.map((b) => [b.id, b.name, b.kind === "no_brand" ? "(no brand)" : dash(b.website)]),
    ["ID", "NAME", "WEBSITE"],
  );
}

export function formatAccount(d: { balance: number; plan: { name: string | null; active: boolean; studio_access: boolean }; role: string; brands: Brand[] }): string {
  return [`Balance: ${d.balance} credits`, `Plan: ${d.plan.name ?? "none"}${d.plan.active ? "" : " (inactive)"}`, `Role: ${d.role}`, "", formatBrands(d)].join("\n");
}

export function formatCreators(d: { creators: { id: string; name: string; tags: string[]; active: boolean; custom: boolean; brand_id: string | null }[] }): string {
  return table(
    d.creators.map((c) => [c.id, c.name, c.custom ? "custom" : "library", c.tags.slice(0, 4).join(", ")]),
    ["ID", "NAME", "TYPE", "TAGS"],
  );
}

export function formatProducts(d: { source: string; products: { id: string; title: string; price: string | null; in_stock: boolean | null }[] }): string {
  return `${table(
    d.products.map((p) => [p.id, p.title, dash(p.price), p.in_stock === false ? "out of stock" : ""]),
    ["ID", "TITLE", "PRICE", ""],
  )}\n(from ${d.source})`;
}

export function formatVideos(d: { videos: { id: string; kind: string; version: number | null; title: string; duration_sec: number; quality: string | null; created_at: string }[]; next_cursor: string | null }): string {
  const t = table(
    d.videos.map((v) => [v.id + (v.version ? ` v${v.version}` : ""), v.kind, `${Math.round(v.duration_sec)}s`, dash(v.quality), v.created_at.slice(0, 10), v.title]),
    ["ID", "KIND", "LENGTH", "QUALITY", "MADE", "TITLE"],
  );
  return d.next_cursor ? `${t}\nMore: --cursor ${d.next_cursor}` : t;
}
