import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { EXIT } from "../src/exit-codes.js";
import { followHttps } from "../src/upload.js";
import { API_KEY, apiError, fake, job, json, ORIGIN, routes, type Fake, type Handler } from "./helpers.js";

const env = { SCROLLING_API_URL: ORIGIN, SCROLLING_API_KEY: API_KEY };

const estimate = { quote_id: "q1.body.mac", credits: 300, balance: 1000, balance_after: 700, enough: true, monthly_cap_left: null, expires_at: "2026-10-21T12:15:00Z", next_step: "…" };
const started = { job_id: "job_abc12345", kind: "render", status: "queued", credits_held: 300, replayed: false, estimated_seconds: 240, poll_after_seconds: 10, watch_url: `${ORIGIN}/app/create`, next_step: "…" };

const CREATE = ["create", "--brand", "brd_x", "--creator", "cr_a,cr_b", "--length", "30", "--idea", "Mei unboxes @Product 1"];

function spendServer(extra: Record<string, Handler> = {}): Handler {
  return routes({
    "POST /api/v1/estimates": () => json(estimate),
    "POST /api/v1/create": () => json(started, 202),
    ...extra,
  });
}

const posted = (f: Fake, path: string) => f.requests.filter((r) => r.method === "POST" && new URL(r.url).pathname === `/api/v1${path}`);
const bodyOf = (f: Fake, path: string) => {
  const i = f.requests.findIndex((r) => r.method === "POST" && new URL(r.url).pathname === `/api/v1${path}`);
  return JSON.parse(f.bodies[i]) as Record<string, unknown>;
};

describe("confirmation gate", () => {
  test("no terminal and no --yes: the estimate on stdout, exit 9, nothing started", async () => {
    const f = fake({ env, handler: spendServer() });
    assert.equal(await f.run(...CREATE), EXIT.confirm);
    const out = JSON.parse(f.out.stdout) as { confirmation_required: boolean; estimate: typeof estimate };
    assert.equal(out.confirmation_required, true);
    assert.equal(out.estimate.credits, 300);
    assert.equal(posted(f, "/create").length, 0);
    assert.deepEqual(bodyOf(f, "/estimates"), { kind: "video", length_seconds: 30 });
  });

  test("--no-input on a terminal: still never asks", async () => {
    const f = fake({ env, tty: true, handler: spendServer(), answers: ["y"] });
    assert.equal(await f.run("--no-input", ...CREATE), EXIT.confirm);
    assert.equal(posted(f, "/create").length, 0);
  });

  test("--yes: started with the quote and an Idempotency-Key", async () => {
    const f = fake({ env, handler: spendServer() });
    assert.equal(await f.run(...CREATE, "--yes"), 0);
    const [req] = posted(f, "/create");
    const key = req.headers.get("idempotency-key");
    assert.match(key ?? "", /^[0-9a-f-]{36}$/);
    const body = bodyOf(f, "/create");
    assert.equal(body.quote_id, "q1.body.mac");
    assert.equal(body.idempotency_key, key);
    assert.deepEqual(body.creator_ids, ["cr_a", "cr_b"]);
    assert.equal(JSON.parse(f.out.stdout).job_id, "job_abc12345");
    assert.equal(JSON.parse(f.out.stdout).idempotency_key, key);
  });

  test("--idempotency-key is used as given", async () => {
    const f = fake({ env, handler: spendServer() });
    await f.run(...CREATE, "--yes", "--idempotency-key", "retry-me-1");
    assert.equal(posted(f, "/create")[0].headers.get("idempotency-key"), "retry-me-1");
  });

  test("--max-credits: goes ahead up to N, exit 9 above it", async () => {
    const ok = fake({ env, handler: spendServer() });
    assert.equal(await ok.run(...CREATE, "--max-credits", "300"), 0);
    assert.equal(bodyOf(ok, "/create").max_credits, 300);
    const no = fake({ env, handler: spendServer() });
    assert.equal(await no.run(...CREATE, "--max-credits", "299"), EXIT.confirm);
    assert.equal(posted(no, "/create").length, 0);
  });

  test("a terminal asks; no means not started", async () => {
    const yes = fake({ env, tty: true, handler: spendServer(), answers: ["y"] });
    assert.equal(await yes.run(...CREATE), 0);
    assert.match(yes.out.stderr, /This costs 300 credits/);
    const no = fake({ env, tty: true, handler: spendServer(), answers: ["n"] });
    assert.equal(await no.run(...CREATE), EXIT.confirm);
    assert.equal(posted(no, "/create").length, 0);
  });

  test("a server 428 (quote expired): the fresh estimate goes through the gate again, same key", async () => {
    let n = 0;
    const same = { ...estimate, quote_id: "q1.fresh.mac" };
    const f = fake({ env, handler: spendServer({ "POST /api/v1/create": () => (++n === 1 ? apiError(428, "confirmation_required", "Show the price.", { estimate: same }) : json(started, 202)) }) });
    assert.equal(await f.run(...CREATE, "--yes"), 0);
    const reqs = posted(f, "/create");
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0].headers.get("idempotency-key"), reqs[1].headers.get("idempotency-key"));
    assert.equal(JSON.parse(f.bodies[f.requests.indexOf(reqs[1])]).quote_id, "q1.fresh.mac");

    let c = 0;
    const cheaper = fake({ env, handler: spendServer({ "POST /api/v1/create": () => (++c === 1 ? apiError(428, "confirmation_required", "Show the price.", { estimate: { ...same, credits: 250 } }) : json(started, 202)) }) });
    assert.equal(await cheaper.run(...CREATE, "--yes"), 0, "a lower price is within what --yes accepted");

    const fresh = { ...estimate, quote_id: "q1.fresh.mac", credits: 320 };
    const capped = fake({ env, handler: spendServer({ "POST /api/v1/create": () => apiError(428, "confirmation_required", "Show the price.", { estimate: fresh }) }) });
    assert.equal(await capped.run(...CREATE, "--max-credits", "300"), EXIT.confirm);
    let m = 0;
    const roomy = fake({ env, handler: spendServer({ "POST /api/v1/create": () => (++m === 1 ? apiError(428, "confirmation_required", "Show the price.", { estimate: fresh }) : json(started, 202)) }) });
    assert.equal(await roomy.run(...CREATE, "--max-credits", "400"), 0, "--max-credits N still goes ahead up to N");
  });

  test("--yes never consents silently to a higher price after a 428: exit 9 with the new estimate", async () => {
    const fresh = { ...estimate, quote_id: "q1.fresh.mac", credits: 320, balance_after: 680 };
    const f = fake({ env, handler: spendServer({ "POST /api/v1/create": () => apiError(428, "confirmation_required", "Show the price.", { estimate: fresh }) }) });
    assert.equal(await f.run(...CREATE, "--yes"), EXIT.confirm);
    assert.equal(posted(f, "/create").length, 1, "not sent again with the new quote");
    const out = JSON.parse(f.out.stdout) as { confirmation_required: boolean; estimate: typeof fresh };
    assert.equal(out.confirmation_required, true);
    assert.deepEqual(out.estimate, fresh);
    assert.match(f.out.stderr, /price changed from 300 to 320/);
  });

  test("not enough credits: exit 6", async () => {
    const f = fake({ env, handler: spendServer({ "POST /api/v1/create": () => apiError(402, "credits", "Needs 300.", { needed: 300, balance: 10 }) }) });
    assert.equal(await f.run(...CREATE, "--yes"), EXIT.payment);
  });

  test("a free approval consents to 0 credits; 1080p estimates swap_hd first", async () => {
    const free = fake({ env, handler: routes({ "POST /api/v1/swaps/swp_abc12345/revise": () => json({ ...started, job_id: "swp_abc12345", kind: "swap", credits_held: 0 }, 202) }) });
    assert.equal(await free.run("swap", "approve", "swp_abc12345", "--version", "2", "--quality", "720p"), 0);
    assert.equal(bodyOf(free, "/swaps/swp_abc12345/revise").max_credits, 0);

    const hd = fake({ env, handler: routes({ "POST /api/v1/estimates": () => json(estimate), "POST /api/v1/swaps/swp_abc12345/revise": () => json(started, 202) }) });
    assert.equal(await hd.run("swap", "approve", "swp_abc12345", "--version", "2", "--quality", "1080p", "--yes"), 0);
    assert.deepEqual(bodyOf(hd, "/estimates"), { kind: "swap_hd", job_id: "swp_abc12345", version: 2 });
  });

  test("swap from a platform link passes the link through and estimates by seconds", async () => {
    const f = fake({ env, handler: routes({ "POST /api/v1/estimates": () => json(estimate), "POST /api/v1/swaps": () => json({ ...started, kind: "swap" }, 202) }) });
    const link = "https://www.tiktok.com/@shop/video/123";
    assert.equal(await f.run("swap", "--brand", "brd_x", "--kind", "person", "--video", link, "--seconds", "20", "--creator", "cr_a", "--yes"), 0);
    assert.deepEqual(bodyOf(f, "/estimates"), { kind: "swap", seconds: 20 });
    const body = bodyOf(f, "/swaps");
    assert.equal(body.video_url, link);
    assert.equal(body.kind, "person");
  });

  test("create --write-only writes a script for free", async () => {
    const f = fake({ env, handler: routes({ "POST /api/v1/scripts": () => json({ idea: "i", script: "s", comment: null, words: 1, next_step: "n" }) }) });
    assert.equal(await f.run("create", "--brand", "brd_x", "--creator", "cr_a", "--length", "15", "--write-only"), 0);
    assert.deepEqual(bodyOf(f, "/scripts"), { brand_id: "brd_x", creator_ids: ["cr_a"], length_seconds: 15 });
    assert.equal(posted(f, "/estimates").length, 0);
  });
});

describe("waiting", () => {
  test("succeeded → 0, with ?wait=40", async () => {
    const answers = [job("running"), job("succeeded", { video: { id: "vid_1", watch_url: "https://x" } })];
    const f = fake({ env, handler: () => json(answers.shift()!) });
    assert.equal(await f.run("jobs", "wait", "job_abc12345"), 0);
    assert.equal(new URL(f.requests[0].url).searchParams.get("wait"), "40");
    assert.equal(JSON.parse(f.out.stdout).job.status, "succeeded");
  });

  test("failed → 8 with the job on stdout", async () => {
    const f = fake({ env, handler: () => json(job("failed", { error: "The video couldn't be made." })) });
    assert.equal(await f.run("jobs", "wait", "job_abc12345"), EXIT.jobFailed);
    assert.equal(JSON.parse(f.out.stdout).job.status, "failed");
    assert.match(f.out.stderr, /couldn't be made/);
  });

  test("timeout → 7 with the command to resume", async () => {
    const f = fake({ env, handler: () => json(job("running")) });
    assert.equal(await f.run("jobs", "wait", "job_abc12345", "--timeout", "30"), EXIT.stillRunning);
    const out = JSON.parse(f.out.stdout) as { next: string };
    assert.equal(out.next, "scrolling jobs wait job_abc12345");
    assert.match(f.out.stderr, /still_running/);
  });

  test("Ctrl-C → 130 with the command to resume", async () => {
    const ac = new AbortController();
    const f = fake({
      env,
      signal: ac.signal,
      handler: () => {
        ac.abort();
        return json(job("running"));
      },
    });
    assert.equal(await f.run("jobs", "wait", "job_abc12345"), EXIT.interrupted);
    assert.match(f.out.stderr, /scrolling jobs wait job_abc12345/);
  });

  test("create --yes --wait follows the job to the end", async () => {
    const answers = [job("running"), job("succeeded")];
    const f = fake({ env, handler: spendServer({ "GET /api/v1/jobs/job_abc12345": () => json(answers.shift()!) }) });
    assert.equal(await f.run(...CREATE, "--yes", "--wait"), 0);
    const out = JSON.parse(f.out.stdout) as { started: { job_id: string }; job: { status: string } };
    assert.equal(out.started.job_id, "job_abc12345");
    assert.equal(out.job.status, "succeeded");
  });

  test("jobs cancel needs --yes without a terminal", async () => {
    const f = fake({ env, handler: routes({ "DELETE /api/v1/jobs/job_abc12345": () => json({ job_id: "job_abc12345", status: "cancelled", credits_refunded: 200, credits_kept: 100 }) }) });
    assert.equal(await f.run("jobs", "cancel", "job_abc12345"), EXIT.confirm);
    assert.equal(f.requests.length, 0);
    assert.equal(await f.run("jobs", "cancel", "job_abc12345", "--yes"), 0);
  });
});

describe("uploads", () => {
  function server(location: string, putStatus = 307): { f: Fake; puts: string[] } {
    const puts: string[] = [];
    const f = fake({
      env,
      handler: async (req) => {
        const u = new URL(req.url);
        if (req.method === "POST" && u.pathname === "/api/v1/uploads")
          return json({ upload_id: "up1.target.mac", upload_url: `${ORIGIN}/api/v1/uploads/up1.target.mac`, method: "PUT", headers: { "Content-Type": "video/mp4" }, max_bytes: 1_000_000, expires_at: "x", next_step: "x" });
        if (req.method === "PUT") {
          puts.push(req.url);
          assert.equal(req.headers.get("authorization"), null, "the upload URL is the credential; never our token");
          if (u.origin === ORIGIN) return new Response(null, { status: putStatus, headers: { Location: location } });
          return new Response(null, { status: 200 });
        }
        if (req.method === "POST" && u.pathname === "/api/v1/uploads/complete") return json({ file_id: "u1.file.mac", kind: "video", name: "clip.mp4", size_bytes: 11, duration_seconds: 3, expires_at: "x" });
        return apiError(404, "not_found");
      },
    });
    writeFileSync(join(f.dir, "clip.mp4"), "hello video");
    return { f, puts };
  }

  test("prepare → PUT → 307 to https storage → PUT again → finalize", async () => {
    const { f, puts } = server("https://storage.test/upload/sign/abc?token=t");
    assert.equal(await f.run("uploads", "add", join(f.dir, "clip.mp4")), 0);
    assert.deepEqual(puts, [`${ORIGIN}/api/v1/uploads/up1.target.mac`, "https://storage.test/upload/sign/abc?token=t"]);
    assert.equal(f.bodies[f.requests.findIndex((r) => r.url.startsWith("https://storage.test"))], "hello video");
    assert.equal(JSON.parse(f.out.stdout).file_id, "u1.file.mac");
  });

  test("a redirect to plain http is refused", async () => {
    const { f, puts } = server("http://storage.test/upload");
    assert.equal(await f.run("uploads", "add", join(f.dir, "clip.mp4")), EXIT.error);
    assert.equal(puts.length, 1);
    assert.match(f.out.stderr, /unsafe_redirect/);
  });

  test("only 307/308 are followed", async () => {
    const { f } = server("https://storage.test/x", 302);
    assert.equal(await f.run("uploads", "add", join(f.dir, "clip.mp4")), EXIT.error);
    assert.match(f.out.stderr, /bad_redirect/);
  });

  test("followHttps resolves relative locations and refuses others", () => {
    assert.equal(followHttps("https://a.test/x/y", "/z"), "https://a.test/z");
    assert.throws(() => followHttps("https://a.test/x", "http://b.test/"), /non-https/);
    assert.throws(() => followHttps("https://a.test/x", "javascript:alert(1)"), /non-https/);
    assert.throws(() => followHttps("https://a.test/x", null), /destination/);
  });

  test("an unknown file type is a usage error before anything is sent", async () => {
    const f = fake({ env });
    writeFileSync(join(f.dir, "notes.txt"), "x");
    assert.equal(await f.run("uploads", "add", join(f.dir, "notes.txt")), EXIT.usage);
    assert.equal(f.requests.length, 0);
  });

  test("a link is imported", async () => {
    const f = fake({ env, handler: routes({ "POST /api/v1/uploads/import": () => json({ file_id: "u1.x.y", kind: "image", name: null, size_bytes: 1, duration_seconds: null, expires_at: "x" }) }) });
    assert.equal(await f.run("uploads", "add", "https://example.com/a.jpg", "--kind", "image"), 0);
    assert.deepEqual(JSON.parse(f.bodies[0]), { url: "https://example.com/a.jpg", kind: "image" });
  });
});
