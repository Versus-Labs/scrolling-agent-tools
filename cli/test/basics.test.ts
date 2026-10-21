import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { s256, newPkce, newState } from "../src/auth/pkce.js";
import { EXIT, exitForError } from "../src/exit-codes.js";
import { Output, redact, toHuman } from "../src/output.js";
import { API_KEY, apiError, fake, json, ORIGIN, routes } from "./helpers.js";

describe("exit codes", () => {
  const cases: [number, string, number][] = [
    [428, "confirmation_required", EXIT.confirm],
    [402, "credits", EXIT.payment],
    [402, "plan", EXIT.payment],
    [402, "credit_cap", EXIT.payment],
    [422, "idempotency_conflict", EXIT.duplicate],
    [409, "idempotency_expired", EXIT.duplicate],
    [409, "idempotency_in_progress", EXIT.error],
    [429, "rate_limited", EXIT.error],
    [409, "busy", EXIT.error],
    [401, "invalid_token", EXIT.auth],
    [403, "insufficient_scope", EXIT.auth],
    [403, "agent_read_only", EXIT.auth],
    [404, "not_found", EXIT.notFound],
    [400, "invalid_input", EXIT.usage],
    [422, "seconds_required", EXIT.usage],
    [409, "not_cancellable", EXIT.error],
    [409, "price_changed", EXIT.error],
    [500, "internal", EXIT.error],
    [503, "agent_access_off", EXIT.error],
  ];
  for (const [status, code, exit] of cases) {
    test(`${status} ${code} → ${exit}`, () => assert.equal(exitForError(status, code), exit));
  }

  test("an API error exits with its code and prints JSON on stderr, nothing on stdout", async () => {
    const f = fake({ env: { SCROLLING_API_URL: ORIGIN, SCROLLING_API_KEY: API_KEY }, handler: routes({ "GET /api/v1/account": () => apiError(402, "plan", "Needs a plan.") }) });
    assert.equal(await f.run("account"), EXIT.payment);
    assert.equal(f.out.stdout, "");
    const err = JSON.parse(f.out.stderr.trim()) as { error: { code: string; exit_code: number } };
    assert.equal(err.error.code, "plan");
    assert.equal(err.error.exit_code, 6);
  });

  test("rate limited: exit 1 with retry_after", async () => {
    const f = fake({ env: { SCROLLING_API_URL: ORIGIN, SCROLLING_API_KEY: API_KEY }, handler: () => apiError(429, "rate_limited", "Slow down.", undefined, { "Retry-After": "12" }) });
    assert.equal(await f.run("account"), EXIT.error);
    assert.equal((JSON.parse(f.out.stderr) as { error: { details: { retry_after: number } } }).error.details.retry_after, 12);
  });

  test("usage errors exit 2; help and version exit 0", async () => {
    assert.equal(await fake().run("create", "--brand", "x"), EXIT.usage);
    assert.equal(await fake().run("create", "--brand", "b", "--creator", "c", "--length", "45"), EXIT.usage);
    assert.equal(await fake().run("nope"), EXIT.usage);
    const v = fake();
    assert.equal(await v.run("--version"), EXIT.ok);
    assert.equal(v.out.stdout.trim(), "0.0.0-test");
    const h = fake();
    assert.equal(await h.run("--help"), EXIT.ok);
    assert.match(h.out.stdout, /Exit codes:/);
  });

  test("not logged in → exit 3", async () => {
    const f = fake({ env: { SCROLLING_API_URL: ORIGIN } });
    assert.equal(await f.run("account"), EXIT.auth);
    assert.match(f.out.stderr, /not_logged_in/);
  });
});

describe("output", () => {
  const account = { balance: 1200, plan: { name: "Pro", active: true, studio_access: true }, role: "owner", brands: [{ id: "brd_1", name: "Aya", kind: "brand", website: "aya.com", logo: null }] };

  test("JSON when stdout is not a terminal", async () => {
    const f = fake({ env: { SCROLLING_API_URL: ORIGIN, SCROLLING_API_KEY: API_KEY }, handler: () => json(account) });
    assert.equal(await f.run("account"), 0);
    assert.deepEqual(JSON.parse(f.out.stdout), account);
  });

  test("readable text on a terminal; --json forces JSON; --quiet prints the bare value", async () => {
    const f = fake({ tty: true, env: { SCROLLING_API_URL: ORIGIN, SCROLLING_API_KEY: API_KEY }, handler: () => json(account) });
    await f.run("account");
    assert.match(f.out.stdout, /Balance: 1200 credits/);
    const j = fake({ tty: true, env: { SCROLLING_API_URL: ORIGIN, SCROLLING_API_KEY: API_KEY }, handler: () => json(account) });
    await j.run("account", "--json");
    assert.deepEqual(JSON.parse(j.out.stdout), account);
    const q = fake({ tty: true, env: { SCROLLING_API_URL: ORIGIN, SCROLLING_API_KEY: API_KEY }, handler: () => json(account) });
    await q.run("--quiet", "account");
    assert.equal(q.out.stdout, "1200\n");
  });

  test("colour only on a terminal, never with NO_COLOR, TERM=dumb or --no-color", () => {
    const colored = (env: Record<string, string>, opts = {}) => new Output(fake({ tty: true, env }).ctx, opts).paint("31", "x") !== "x";
    assert.equal(colored({}), true);
    assert.equal(colored({ NO_COLOR: "1" }), false);
    assert.equal(colored({ TERM: "dumb" }), false);
    assert.equal(colored({}, { color: false }), false);
    assert.equal(new Output(fake({ tty: false }).ctx, {}).paint("31", "x"), "x");
  });

  test("redact keeps a prefix and the last 4 characters", () => {
    const at = "scr_at_" + "Z".repeat(32) + "wxyz12";
    assert.equal(redact(`Bearer ${at}`), "Bearer scr_at_…yz12");
    assert.equal(redact("PUT https://x/api/v1/uploads/up1.aaaa.bbbbcccc"), "PUT https://x/api/v1/uploads/up1.…cccc");
    assert.equal(redact("https://x/cb?code=secret123&state=abc"), "https://x/cb?code=…&state=…");
  });

  test("--debug logs requests with tokens redacted", async () => {
    const f = fake({ env: { SCROLLING_API_URL: ORIGIN, SCROLLING_API_KEY: API_KEY }, handler: () => json({ brands: [] }) });
    await f.run("--debug", "brands", "list");
    assert.match(f.out.stderr, /\[debug\] GET https:\/\/scrolling\.test\/api\/v1\/brands → 200/);
    assert.ok(!f.out.stderr.includes(API_KEY));
  });

  test("toHuman lists nested values", () => {
    assert.equal(toHuman({ a: 1, b: { c: null }, d: [] }), "a: 1\nb:\n  c: -\nd: (none)");
  });
});

describe("PKCE", () => {
  test("RFC 7636 appendix B vector", () => {
    assert.equal(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  test("a fresh verifier is 43 base64url characters and differs each time", () => {
    const { ctx } = fake();
    const a = newPkce(ctx);
    const b = newPkce(ctx);
    assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(a.challenge, s256(a.verifier));
    assert.notEqual(a.verifier, b.verifier);
    assert.notEqual(newState(ctx), newState(ctx));
  });
});
