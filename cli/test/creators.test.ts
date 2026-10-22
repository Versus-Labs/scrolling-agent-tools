import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { formatStarted, formatWait } from "../src/commands/format.js";
import { EXIT } from "../src/exit-codes.js";
import { API_KEY, apiError, fake, json, ORIGIN, routes, type Fake, type Handler } from "./helpers.js";

const env = { SCROLLING_API_URL: ORIGIN, SCROLLING_API_KEY: API_KEY };

const estimate = { quote_id: "q1.creator.mac", credits: 34, balance: 1000, balance_after: 966, enough: true, monthly_cap_left: null, expires_at: "2026-10-22T12:15:00Z", next_step: "…" };
const started = { job_id: "cr_mei12345", kind: "creator", status: "queued", credits_held: 34, replayed: false, estimated_seconds: 180, poll_after_seconds: 20, watch_url: `${ORIGIN}/app/creators`, next_step: "…" };
const creator = { id: "cr_mei12345", name: "Mei", image: null, tags: ["custom"], active: true, custom: true, brand_id: "brd_x" };
const creatorJob = (status: string, extra: Record<string, unknown> = {}) => ({
  job: { id: "cr_mei12345", kind: "creator", status, progress: status === "succeeded" ? 100 : 40, step: 2, steps: 4, headline: "Designing their face", error: null, credits_held: 34, created_at: "2026-10-22T12:00:00Z", title: "Mei", brand_id: "brd_x", video: null, creator, ...extra },
  poll_after_seconds: 20,
  next_step: "…",
});

const BASE = ["creators", "create", "--brand", "brd_x", "--name", "Mei"];

function server(extra: Record<string, Handler> = {}): Handler {
  return routes({
    "POST /api/v1/estimates": () => json(estimate),
    "POST /api/v1/creators": () => json(started, 202),
    ...extra,
  });
}

const posted = (f: Fake, path: string) => f.requests.filter((r) => r.method === "POST" && new URL(r.url).pathname === `/api/v1${path}`);
const bodyOf = (f: Fake, path: string) => {
  const i = f.requests.findIndex((r) => r.method === "POST" && new URL(r.url).pathname === `/api/v1${path}`);
  return JSON.parse(f.bodies[i]) as Record<string, unknown>;
};

describe("creators create", () => {
  test("designed: the body uses the API's field names, estimated as kind creator, sent with the quote and an Idempotency-Key", async () => {
    const f = fake({ env, handler: server() });
    const code = await f.run(
      ...BASE,
      "--description",
      "  Runs a small bakery  ",
      "--kind",
      "person",
      "--gender",
      "Woman",
      "--age",
      "25-34",
      "--outfit",
      "cozy",
      "--energy",
      "warm,playful",
      "--voice",
      "bright",
      "--accent",
      "irish",
      "--yes",
    );
    assert.equal(code, 0, f.out.stderr);
    assert.deepEqual(bodyOf(f, "/estimates"), { kind: "creator" });
    const [req] = posted(f, "/creators");
    const key = req.headers.get("idempotency-key");
    assert.match(key ?? "", /^[0-9a-f-]{36}$/);
    assert.deepEqual(bodyOf(f, "/creators"), {
      brand_id: "brd_x",
      name: "Mei",
      from: "description",
      description: "Runs a small bakery",
      kind: "person",
      gender: "woman",
      age: "25-34",
      outfit: "cozy",
      energy: ["warm", "playful"],
      voice: "bright",
      accent: "irish",
      quote_id: "q1.creator.mac",
      idempotency_key: key,
    });
    assert.equal(JSON.parse(f.out.stdout).job_id, "cr_mei12345");
  });

  test("no --from and no photos: designed from a description; repeated --energy collects", async () => {
    const f = fake({ env, handler: server() });
    assert.equal(await f.run(...BASE, "--energy", "calm", "--energy", "expert", "--yes"), 0);
    const body = bodyOf(f, "/creators");
    assert.equal(body.from, "description");
    assert.deepEqual(body.energy, ["calm", "expert"]);
    assert.equal(body.photo_file_ids, undefined);
    assert.equal(posted(f, "/estimates").length, 1);
  });

  test("from a photo: a local --photo is uploaded first and sent as its file id", async () => {
    const puts: string[] = [];
    const f = fake({
      env,
      handler: server({
        "POST /api/v1/uploads": () => json({ upload_id: "up1.photo.mac", upload_url: `${ORIGIN}/api/v1/uploads/up1.photo.mac`, method: "PUT", headers: { "Content-Type": "image/jpeg" }, max_bytes: 1_000_000, expires_at: "x", next_step: "x" }),
        "PUT /api/v1/uploads/up1.photo.mac": (req) => {
          puts.push(req.url);
          return new Response(null, { status: 200 });
        },
        "POST /api/v1/uploads/complete": () => json({ file_id: "u1.photo.mac", kind: "image", name: "sam.jpg", size_bytes: 9, duration_seconds: null, expires_at: "x" }),
      }),
    });
    writeFileSync(join(f.dir, "sam.jpg"), "fake jpeg");
    assert.equal(await f.run(...BASE, "--from", "photo", "--photo", join(f.dir, "sam.jpg"), "--voice", "deep", "--yes"), 0, f.out.stderr);
    assert.equal(puts.length, 1);
    assert.deepEqual(bodyOf(f, "/uploads"), { file_name: "sam.jpg", content_type: "image/jpeg", size_bytes: 9 });
    assert.deepEqual(bodyOf(f, "/estimates"), { kind: "creator" });
    const body = bodyOf(f, "/creators");
    assert.equal(body.from, "photo");
    assert.deepEqual(body.photo_file_ids, ["u1.photo.mac"]);
    assert.equal(body.voice, "deep");
  });

  test("from photos: free, no estimate, consents to 0 credits; a link is imported and a file id passes as it is", async () => {
    const ready = { ...started, status: "succeeded", credits_held: 0, estimated_seconds: 0 };
    const f = fake({
      env,
      handler: server({
        "POST /api/v1/uploads/import": () => json({ file_id: "u1.linked.mac", kind: "image", name: null, size_bytes: 1, duration_seconds: null, expires_at: "x" }),
        "POST /api/v1/creators": () => json(ready, 202),
      }),
    });
    assert.equal(await f.run(...BASE, "--from", "photos", "--photo", "https://example.com/a.jpg", "--photo", "u1.given.mac"), 0, f.out.stderr);
    assert.equal(posted(f, "/estimates").length, 0);
    assert.deepEqual(bodyOf(f, "/uploads/import"), { url: "https://example.com/a.jpg" });
    const body = bodyOf(f, "/creators");
    assert.deepEqual(body.photo_file_ids, ["u1.linked.mac", "u1.given.mac"]);
    assert.equal(body.from, "photos");
    assert.equal(body.max_credits, 0);
    assert.equal(body.quote_id, undefined);
    assert.equal(JSON.parse(f.out.stdout).status, "succeeded");
  });

  const usage: [string, string[], RegExp][] = [
    ["photos without --from", ["--photo", "u1.a"], /--from photo .* or --from photos/],
    ["--from photo without a photo", ["--from", "photo"], /exactly one --photo/],
    ["--from photo with two photos", ["--from", "photo", "--photo", "u1.a", "--photo", "u1.b"], /exactly one --photo/],
    ["--from photos with four photos", ["--from", "photos", "--photo", "u1.a", "--photo", "u1.b", "--photo", "u1.c", "--photo", "u1.d"], /1 to 3 --photo/],
    ["--from photos without a photo", ["--from", "photos"], /1 to 3 --photo/],
    ["--from description with a photo", ["--from", "description", "--photo", "u1.a"], /takes no --photo/],
    ["--from photo with look choices", ["--from", "photo", "--photo", "u1.a", "--gender", "man", "--outfit", "smart"], /leave out --gender, --outfit/],
    ["--from photos with a description", ["--from", "photos", "--photo", "u1.a", "--description", "Tall"], /leave out --description/],
    ["--from photos with choices", ["--from", "photos", "--photo", "u1.a", "--energy", "calm", "--accent", "french"], /leave out --energy, --accent/],
    ["three energies", ["--energy", "calm,warm,upbeat"], /at most 2 --energy/],
    ["the same energy twice", ["--energy", "calm", "--energy", "calm"], /each --energy once/],
    ["an unknown kind", ["--kind", "robot"], /--kind is one of person, extreme/],
    ["an unknown --from", ["--from", "video"], /--from is one of description, photo, photos/],
    ["a description over 300 characters", ["--description", "x".repeat(301)], /at most 300/],
  ];
  for (const [what, args, message] of usage) {
    test(`usage: ${what} → exit 2, nothing sent`, async () => {
      const f = fake({ env, handler: server() });
      assert.equal(await f.run(...BASE, ...args, "--yes"), EXIT.usage);
      assert.equal(f.requests.length, 0);
      assert.match(f.out.stderr, message);
    });
  }

  test("usage: a name over 40 characters, or none", async () => {
    const long = fake({ env, handler: server() });
    assert.equal(await long.run("creators", "create", "--brand", "brd_x", "--name", "N".repeat(41), "--yes"), EXIT.usage);
    assert.match(long.out.stderr, /at most 40/);
    const none = fake({ env, handler: server() });
    assert.equal(await none.run("creators", "create", "--brand", "brd_x", "--yes"), EXIT.usage);
    assert.equal(long.requests.length + none.requests.length, 0);
  });

  test("no terminal and no --yes: the estimate on stdout, exit 9, nothing started", async () => {
    const f = fake({ env, handler: server() });
    assert.equal(await f.run(...BASE, "--gender", "woman"), EXIT.confirm);
    const out = JSON.parse(f.out.stdout) as { confirmation_required: boolean; estimate: typeof estimate };
    assert.equal(out.confirmation_required, true);
    assert.equal(out.estimate.credits, 34);
    assert.equal(posted(f, "/creators").length, 0);
  });

  test("--max-credits below the price: exit 9; at the price: sent with max_credits", async () => {
    const no = fake({ env, handler: server() });
    assert.equal(await no.run(...BASE, "--max-credits", "33"), EXIT.confirm);
    assert.equal(posted(no, "/creators").length, 0);
    const ok = fake({ env, handler: server() });
    assert.equal(await ok.run(...BASE, "--max-credits", "34"), 0);
    assert.equal(bodyOf(ok, "/creators").max_credits, 34);
  });

  test("the agent cap: a 429 busy is exit 1", async () => {
    const f = fake({ env, handler: server({ "POST /api/v1/creators": () => apiError(429, "busy", "This app already has 2 Creators being made.") }) });
    assert.equal(await f.run(...BASE, "--yes"), EXIT.error);
    assert.match(f.out.stderr, /2 Creators being made/);
  });

  test("--wait follows the cr_ job to the end", async () => {
    const answers = [creatorJob("running"), creatorJob("succeeded")];
    const f = fake({ env, handler: server({ "GET /api/v1/jobs/cr_mei12345": () => json(answers.shift()!) }) });
    assert.equal(await f.run(...BASE, "--yes", "--wait"), 0, f.out.stderr);
    const waited = f.requests.filter((r) => r.method === "GET");
    assert.equal(new URL(waited[0].url).pathname, "/api/v1/jobs/cr_mei12345");
    const out = JSON.parse(f.out.stdout) as { started: { job_id: string }; job: { status: string; creator: { name: string } } };
    assert.equal(out.started.job_id, "cr_mei12345");
    assert.equal(out.job.status, "succeeded");
    assert.equal(out.job.creator.name, "Mei");
  });

  test("jobs wait cr_…: a failed build is exit 8", async () => {
    const f = fake({ env, handler: () => json(creatorJob("failed", { error: "We couldn't make this Creator. Your credits are back." })) });
    assert.equal(await f.run("jobs", "wait", "cr_mei12345"), EXIT.jobFailed);
    assert.match(f.out.stderr, /credits are back/);
  });
});

describe("cost creator", () => {
  test("asks for kind creator and prints the price", async () => {
    const f = fake({ env, handler: server() });
    assert.equal(await f.run("cost", "creator"), 0);
    assert.deepEqual(bodyOf(f, "/estimates"), { kind: "creator" });
    assert.equal(JSON.parse(f.out.stdout).credits, 34);
    const q = fake({ env, tty: true, handler: server() });
    assert.equal(await q.run("--quiet", "cost", "creator"), 0);
    assert.equal(q.out.stdout.trim(), "34");
  });
});

describe("creator text", () => {
  test("a finished Creator prints as `cr_… <name> ready`", () => {
    assert.equal(formatWait(creatorJob("succeeded") as Parameters<typeof formatWait>[0]).split("\n")[0], "cr_mei12345 Mei ready");
    assert.match(formatWait(creatorJob("running") as Parameters<typeof formatWait>[0]), /^cr_mei12345 {2}running {2}40%/);
  });

  test("a Creator from photos is ready at once; a build says how to follow it", () => {
    assert.match(formatStarted({ ...started, kind: "creator", status: "succeeded", credits_held: 0 }), /^Ready: cr_mei12345\. Nothing charged\./);
    assert.match(formatStarted({ ...started, kind: "creator" }), /Follow it: scrolling jobs wait cr_mei12345/);
  });

  test("a ready Creator says \"Nothing charged\" only when nothing was held; a replayed build that finished prints its credits", () => {
    const replayedBuild = formatStarted({ ...started, kind: "creator", status: "succeeded", credits_held: 34, replayed: true });
    assert.doesNotMatch(replayedBuild, /Nothing charged/);
    assert.match(replayedBuild, /^Already made \(same idempotency key\): cr_mei12345\. Credits held: 34 \(charged once; nothing charged again\)\./);
    assert.match(formatStarted({ ...started, kind: "creator", status: "succeeded", credits_held: 34 }), /^Ready: cr_mei12345\. Credits held: 34\./);
    assert.match(formatStarted({ ...started, kind: "creator", status: "succeeded", credits_held: 0, replayed: true }), /^Already made \(same idempotency key\): cr_mei12345\. Nothing charged\./);
  });
});
