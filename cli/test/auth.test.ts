import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nextPoll, pollDevice } from "../src/auth/device.js";
import { callbackHandler, startLoopback } from "../src/auth/loopback.js";
import { accountKey, readPending, TokenStore, type TokenSet } from "../src/auth/store.js";
import { OAuthSession } from "../src/auth/tokens.js";
import { asMetadataUrl, checkDiscovery } from "../src/discovery.js";
import { EXIT } from "../src/exit-codes.js";
import { Api } from "../src/http.js";
import { browserCommand, checkBrowserUrl, openBrowser } from "../src/open-browser.js";
import { Output } from "../src/output.js";
import { apiError, discoveryRoutes, fake, form, json, ORIGIN, routes } from "./helpers.js";

const AT1 = "scr_at_" + "1".repeat(32) + "aaaaaa";
const AT2 = "scr_at_" + "2".repeat(32) + "bbbbbb";
const RT1 = "scr_rt_" + "1".repeat(32) + "cccccc";
const RT2 = "scr_rt_" + "2".repeat(32) + "dddddd";
const account = accountKey("default", ORIGIN);

const stored = (o: Partial<TokenSet> = {}): TokenSet => ({
  access_token: AT1,
  refresh_token: RT1,
  expires_at: Date.UTC(2026, 9, 21, 13),
  scope: "scrolling:read scrolling:create",
  issuer: ORIGIN,
  resource: `${ORIGIN}/api/v1`,
  token_endpoint: `${ORIGIN}/api/oauth/token`,
  revocation_endpoint: `${ORIGIN}/api/oauth/revoke`,
  client_id: "scrolling-cli",
  ...o,
});

describe("loopback callback", () => {
  const make = (now = 0) => callbackHandler({ state: "S", issuer: ORIGIN, expiresAt: 1000, now: () => now });

  test("one code, for our state, once", () => {
    const h = make();
    assert.equal(h("GET", "/other").status, 404);
    assert.equal(h("POST", "/callback?state=S&code=c").status, 405);
    const wrong = h("GET", "/callback?state=X&code=c");
    assert.equal(wrong.status, 400);
    assert.equal(wrong.done, undefined, "a wrong state doesn't end the login");
    const ok = h("GET", `/callback?state=S&code=abc&iss=${encodeURIComponent(ORIGIN)}`);
    assert.deepEqual(ok.done, { ok: true, code: "abc" });
    const again = h("GET", "/callback?state=S&code=abc");
    assert.equal(again.status, 400);
    assert.equal(again.done, undefined);
  });

  test("error, foreign issuer, expiry", () => {
    assert.deepEqual(make()("GET", "/callback?state=S&error=access_denied").done, { ok: false, error: "access_denied", description: "The login was declined." });
    assert.equal(make()("GET", "/callback?state=S&code=c&iss=https%3A%2F%2Fevil.test").done?.ok, false);
    assert.equal(make(2000)("GET", "/callback?state=S&code=c").done?.ok, false);
    assert.equal(make()("GET", "/callback?state=S").done?.ok, false);
  });

  test("a real one-shot server on 127.0.0.1", async () => {
    const f = fake();
    const lb = await startLoopback(f.ctx, { state: "S", issuer: ORIGIN });
    try {
      assert.match(lb.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      const bad = await fetch(`${lb.redirectUri}?state=nope&code=x`);
      assert.equal(bad.status, 400);
      const good = await fetch(`${lb.redirectUri}?state=S&code=the-code`);
      assert.equal(good.status, 200);
      assert.deepEqual(await lb.result, { ok: true, code: "the-code" });
    } finally {
      lb.close();
    }
  });
});

describe("device login", () => {
  test("poll state machine", () => {
    assert.deepEqual(nextPoll(5, 400, { error: "authorization_pending" }), { kind: "wait", interval: 5 });
    assert.deepEqual(nextPoll(5, 400, { error: "slow_down" }), { kind: "wait", interval: 10 });
    const denied = nextPoll(5, 400, { error: "access_denied" });
    assert.equal(denied.kind === "fail" && denied.error.exitCode, EXIT.auth);
    const expired = nextPoll(5, 400, { error: "expired_token" });
    assert.equal(expired.kind === "fail" && expired.error.code, "expired_token");
    assert.equal(nextPoll(5, 200, { access_token: AT1, refresh_token: RT1, expires_in: 3600 }).kind, "done");
  });

  test("pollDevice: pending → slow_down (+5 s for good) → done", async () => {
    const answers = [{ error: "authorization_pending" }, { error: "slow_down" }, { error: "authorization_pending" }, { access_token: AT1, refresh_token: RT1, expires_in: 3600, scope: "scrolling:read" }];
    const f = fake({ handler: () => json(answers.shift()!, answers.length ? 400 : 200) });
    const res = await pollDevice(f.ctx, new Output(f.ctx, {}), { deviceCode: "scr_dc_x", tokenEndpoint: `${ORIGIN}/api/oauth/token`, interval: 5, expiresAt: f.clock.t + 600_000 });
    assert.equal(res.access_token, AT1);
    assert.deepEqual(f.sleeps, [5000, 5000, 10000, 10000]);
    const body = form(f.bodies[0]);
    assert.equal(body.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(body.client_id, "scrolling-cli");
  });

  test("pollDevice stops at expiry with exit 3", async () => {
    const f = fake({ handler: () => json({ error: "authorization_pending" }, 400) });
    await assert.rejects(pollDevice(f.ctx, new Output(f.ctx, {}), { deviceCode: "d", tokenEndpoint: `${ORIGIN}/t`, interval: 5, expiresAt: f.clock.t + 12_000 }), (e: { exitCode: number }) => e.exitCode === EXIT.auth);
  });

  test("non-interactive login prints the link as JSON, keeps the device code 0600; --complete finishes it", async () => {
    let polls = 0;
    const handler = routes({
      ...discoveryRoutes(),
      "POST /api/oauth/device": async (req) => {
        const b = form(await req.text());
        assert.equal(b.client_id, "scrolling-cli");
        assert.equal(b.scope, "scrolling:read scrolling:create");
        assert.equal(b.resource, `${ORIGIN}/api/v1`);
        return json({ device_code: "scr_dc_" + "9".repeat(38), user_code: "BCDF-GHJK", verification_uri: `${ORIGIN}/device`, verification_uri_complete: `${ORIGIN}/device?code=BCDF-GHJK`, expires_in: 600, interval: 5 });
      },
      "POST /api/oauth/token": () => (++polls < 2 ? json({ error: "authorization_pending" }, 400) : json({ access_token: AT1, refresh_token: RT1, token_type: "Bearer", expires_in: 3600, scope: "scrolling:read scrolling:create" })),
    });
    const f = fake({ env: { SCROLLING_API_URL: ORIGIN }, handler, keychain: "memory" });
    assert.equal(await f.run("login"), 0);
    assert.deepEqual(JSON.parse(f.out.stdout), { verification_url: `${ORIGIN}/device?code=BCDF-GHJK`, user_code: "BCDF-GHJK", expires_in: 600, next: "scrolling login --complete" });
    assert.equal(f.spawns.length, 0, "no browser without a terminal");
    const pendingPath = join(f.dir, "scrolling", "pending-login.json");
    assert.equal(statSync(pendingPath).mode & 0o777, 0o600);
    assert.ok(readPending(f.ctx, account));

    f.out.stdout = "";
    assert.equal(await f.run("login", "--complete"), 0);
    const done = JSON.parse(f.out.stdout) as { logged_in: boolean; storage: string };
    assert.equal(done.logged_in, true);
    assert.equal(done.storage, "keychain");
    assert.equal(readPending(f.ctx, account), null);
    const saved = JSON.parse(f.keychain!.items.get(`scrolling-cli/${account}`)!) as TokenSet;
    assert.equal(saved.refresh_token, RT1);
    assert.equal(saved.token_endpoint, `${ORIGIN}/api/oauth/token`);
  });

  test("--complete without a pending login: exit 3", async () => {
    const f = fake({ env: { SCROLLING_API_URL: ORIGIN } });
    assert.equal(await f.run("login", "--complete"), EXIT.auth);
  });

  test("--read-only asks for read only", async () => {
    let scope = "";
    const f = fake({
      env: { SCROLLING_API_URL: ORIGIN },
      handler: routes({
        ...discoveryRoutes(),
        "POST /api/oauth/device": async (req) => {
          scope = form(await req.text()).scope;
          return json({ device_code: "d", user_code: "BCDF-GHJK", verification_uri: `${ORIGIN}/device`, expires_in: 600, interval: 5 });
        },
      }),
    });
    assert.equal(await f.run("login", "--read-only", "--non-interactive"), 0);
    assert.equal(scope, "scrolling:read");
  });
});

describe("browser login (loopback + PKCE)", () => {
  test("opens the authorize page, takes the code on 127.0.0.1, exchanges it with the verifier", async () => {
    let tokenBody: Record<string, string> = {};
    let challenge = "";
    const f = fake({
      tty: true,
      platform: "darwin",
      keychain: "memory",
      env: { SCROLLING_API_URL: ORIGIN },
      handler: routes({
        ...discoveryRoutes(),
        "POST /api/oauth/token": async (req) => {
          tokenBody = form(await req.text());
          return json({ access_token: AT1, refresh_token: RT1, token_type: "Bearer", expires_in: 3600, scope: "scrolling:read scrolling:create" });
        },
      }),
    });
    // The "browser": follows the authorize link straight back to the loopback redirect.
    f.ctx.spawn = (command, args, opts) => {
      f.spawns.push({ command, args, opts });
      const u = new URL(args[0]);
      challenge = u.searchParams.get("code_challenge")!;
      assert.equal(u.origin + u.pathname, `${ORIGIN}/oauth/authorize`);
      assert.equal(u.searchParams.get("client_id"), "scrolling-cli");
      assert.equal(u.searchParams.get("code_challenge_method"), "S256");
      assert.equal(u.searchParams.get("resource"), `${ORIGIN}/api/v1`);
      const back = new URL(u.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", "the-code");
      back.searchParams.set("state", u.searchParams.get("state")!);
      back.searchParams.set("iss", ORIGIN);
      setTimeout(() => void fetch(back).catch(() => {}), 5);
      return { on: () => undefined, unref: () => undefined };
    };
    assert.equal(await f.run("login"), 0);
    assert.equal(f.spawns[0].command, "open");
    assert.equal(tokenBody.grant_type, "authorization_code");
    assert.equal(tokenBody.code, "the-code");
    assert.match(tokenBody.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const { s256 } = await import("../src/auth/pkce.js");
    assert.equal(s256(tokenBody.code_verifier), challenge);
    assert.equal(JSON.parse(f.keychain!.items.get(`scrolling-cli/${account}`)!).access_token, AT1);
    assert.ok(!f.out.stderr.includes("the-code"));
  });
});

describe("logout", () => {
  test("revokes the refresh token and forgets the login", async () => {
    let revoked: Record<string, string> = {};
    const f = fake({ env: { SCROLLING_API_URL: ORIGIN }, keychain: "memory", handler: routes({ "POST /api/oauth/revoke": async (req) => ((revoked = form(await req.text())), json({})) }) });
    await new TokenStore(f.ctx, new Output(f.ctx, {})).save(account, stored());
    assert.equal(await f.run("logout"), 0);
    assert.deepEqual(revoked, { token: RT1, token_type_hint: "refresh_token", client_id: "scrolling-cli" });
    assert.equal(f.keychain!.items.size, 0);
    assert.equal(JSON.parse(f.out.stdout).revoked, true);
  });
});

describe("refresh", () => {
  test("a 401 refreshes once, retries, and saves the rotated tokens", async () => {
    let tokenCalls = 0;
    const f = fake({
      keychain: "memory",
      handler: routes({
        "GET /api/v1/account": (req) => (req.headers.get("authorization") === `Bearer ${AT2}` ? json({ ok: true }) : apiError(401, "invalid_token")),
        "POST /api/oauth/token": async (req) => {
          tokenCalls++;
          const b = form(await req.text());
          assert.equal(b.grant_type, "refresh_token");
          assert.equal(b.refresh_token, RT1);
          assert.equal(b.resource, `${ORIGIN}/api/v1`);
          return json({ access_token: AT2, refresh_token: RT2, expires_in: 3600, scope: "scrolling:read" });
        },
      }),
    });
    const out = new Output(f.ctx, {});
    const store = new TokenStore(f.ctx, out);
    await store.save(account, stored());
    const api = new Api(f.ctx, out, ORIGIN, new OAuthSession(f.ctx, out, store, account, stored()));
    assert.deepEqual(await api.get("/account"), { ok: true });
    assert.equal(tokenCalls, 1);
    const after = (await store.load(account))!.tokens;
    assert.equal(after.access_token, AT2);
    assert.equal(after.refresh_token, RT2);
    assert.ok(!f.ctx.fs.existsSync(join(f.dir, "scrolling", "credentials.lock")), "lock released");
  });

  test("an answer without refresh_token (a refresh race) keeps the stored one", async () => {
    const f = fake({
      keychain: "memory",
      handler: routes({
        "GET /api/v1/account": (req) => (req.headers.get("authorization") === `Bearer ${AT2}` ? json({ ok: true }) : apiError(401, "invalid_token")),
        "POST /api/oauth/token": () => json({ access_token: AT2, expires_in: 3600, scope: "scrolling:read scrolling:create" }),
      }),
    });
    const out = new Output(f.ctx, {});
    const store = new TokenStore(f.ctx, out);
    await store.save(account, stored());
    await new Api(f.ctx, out, ORIGIN, new OAuthSession(f.ctx, out, store, account, stored())).get("/account");
    const after = (await store.load(account))!.tokens;
    assert.equal(after.access_token, AT2);
    assert.equal(after.refresh_token, RT1);
  });

  test("another process already refreshed: its tokens are used, no second refresh", async () => {
    let tokenCalls = 0;
    const f = fake({
      keychain: "memory",
      handler: routes({
        "GET /api/v1/account": (req) => (req.headers.get("authorization") === `Bearer ${AT2}` ? json({ ok: true }) : apiError(401, "invalid_token")),
        "POST /api/oauth/token": () => (tokenCalls++, json({ error: "invalid_grant" }, 400)),
      }),
    });
    const out = new Output(f.ctx, {});
    const store = new TokenStore(f.ctx, out);
    await store.save(account, stored({ access_token: AT2, refresh_token: RT2 })); // what the other process saved
    await new Api(f.ctx, out, ORIGIN, new OAuthSession(f.ctx, out, store, account, stored())).get("/account");
    assert.equal(tokenCalls, 0);
  });

  test("a refresh that fails with invalid_grant: exit 3, one try only", async () => {
    let gets = 0;
    const f = fake({
      keychain: "memory",
      handler: routes({ "GET /api/v1/account": () => (gets++, apiError(401, "invalid_token")), "POST /api/oauth/token": () => json({ error: "invalid_grant" }, 400) }),
    });
    const out = new Output(f.ctx, {});
    const store = new TokenStore(f.ctx, out);
    await store.save(account, stored());
    await assert.rejects(new Api(f.ctx, out, ORIGIN, new OAuthSession(f.ctx, out, store, account, stored())).get("/account"), (e: { exitCode: number }) => e.exitCode === EXIT.auth);
    assert.equal(gets, 1);
  });

  test("an access token about to expire is refreshed before the call", async () => {
    const f = fake({ keychain: "memory", handler: routes({ "GET /api/v1/account": (req) => json({ auth: req.headers.get("authorization") }), "POST /api/oauth/token": () => json({ access_token: AT2, refresh_token: RT2, expires_in: 3600 }) }) });
    const out = new Output(f.ctx, {});
    const store = new TokenStore(f.ctx, out);
    const soon = stored({ expires_at: f.clock.t + 30_000 });
    await store.save(account, soon);
    assert.deepEqual(await new Api(f.ctx, out, ORIGIN, new OAuthSession(f.ctx, out, store, account, soon)).get("/account"), { auth: `Bearer ${AT2}` });
  });
});

describe("http retries", () => {
  test("GET retried on 503; a POST without an Idempotency-Key is not; a spending POST keeps its key", async () => {
    let n = 0;
    const f = fake({ handler: () => (++n < 3 ? apiError(503, "unavailable") : json({ ok: n })) });
    const out = new Output(f.ctx, {});
    const api = new Api(f.ctx, out, ORIGIN, null);
    assert.deepEqual(await api.get("/x"), { ok: 3 });

    n = 0;
    await assert.rejects(api.post("/estimates", {}), (e: { status: number }) => e.status === 503);
    assert.equal(n, 1);

    n = 0;
    const g = fake({ handler: () => (++n < 2 ? apiError(502, "unavailable") : json({ ok: true })) });
    await new Api(g.ctx, new Output(g.ctx, {}), ORIGIN, null).post("/create", { a: 1 }, { idempotencyKey: "k-1" });
    assert.deepEqual(
      g.requests.map((r) => r.headers.get("idempotency-key")),
      ["k-1", "k-1"],
    );
  });
});

describe("discovery", () => {
  const prm = { resource: `${ORIGIN}/api/v1`, authorization_servers: [ORIGIN] };
  const asm = (o: Record<string, unknown> = {}) => ({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/oauth/authorize`,
    token_endpoint: `${ORIGIN}/api/oauth/token`,
    revocation_endpoint: `${ORIGIN}/api/oauth/revoke`,
    device_authorization_endpoint: `${ORIGIN}/api/oauth/device`,
    ...o,
  });

  test("everything on the server's origin passes", () => {
    const d = checkDiscovery(ORIGIN, prm, asm());
    assert.equal(d.tokenEndpoint, `${ORIGIN}/api/oauth/token`);
    assert.equal(d.resource, `${ORIGIN}/api/v1`);
  });

  test("anything on another origin is refused", () => {
    assert.throws(() => checkDiscovery(ORIGIN, { ...prm, authorization_servers: ["https://evil.test"] }, asm({ issuer: "https://evil.test" })), /point somewhere else/);
    assert.throws(() => checkDiscovery(ORIGIN, prm, asm({ token_endpoint: "https://evil.test/token" })), /token endpoint/);
    assert.throws(() => checkDiscovery(ORIGIN, prm, asm({ device_authorization_endpoint: "http://scrolling.test/api/oauth/device" })), /device endpoint/);
    assert.throws(() => checkDiscovery(ORIGIN, prm, asm({ issuer: `${ORIGIN}/other` })), /issuer/);
    assert.throws(() => checkDiscovery(ORIGIN, { ...prm, resource: "https://evil.test/api/v1" }, asm()), /resource/);
  });

  test("a login against a tampered server never posts anywhere", async () => {
    const f = fake({ env: { SCROLLING_API_URL: ORIGIN }, handler: routes(discoveryRoutes(ORIGIN, "https://evil.test")) });
    assert.equal(await f.run("login", "--non-interactive"), EXIT.error);
    assert.match(f.out.stderr, /discovery_mismatch/);
    assert.ok(f.requests.every((r) => r.method === "GET" && new URL(r.url).origin === ORIGIN));
  });

  test("RFC 8414 metadata URL", () => {
    assert.equal(asMetadataUrl("https://a.test"), "https://a.test/.well-known/oauth-authorization-server");
    assert.equal(asMetadataUrl("https://a.test/t1"), "https://a.test/.well-known/oauth-authorization-server/t1");
  });
});

describe("open-browser", () => {
  test("only https (or loopback http) pages on the issuer's origin", () => {
    assert.ok(checkBrowserUrl(`${ORIGIN}/oauth/authorize?x=1`, ORIGIN));
    assert.ok(checkBrowserUrl("http://localhost:3007/device?code=BCDF-GHJK", "http://localhost:3007"));
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "http://scrolling.test/oauth", "https://evil.test/oauth", "data:text/html,hi", `${ORIGIN}/a b`, "http://10.0.0.1:3007/x"]) {
      assert.throws(() => checkBrowserUrl(bad, bad.startsWith("http://10.") ? "http://10.0.0.1:3007" : ORIGIN), /Refusing/, bad);
    }
  });

  test("an argument list per platform, never a shell", () => {
    assert.deepEqual(browserCommand("darwin", "https://x"), ["open", ["https://x"]]);
    assert.deepEqual(browserCommand("linux", "https://x"), ["xdg-open", ["https://x"]]);
    assert.deepEqual(browserCommand("win32", "https://x"), ["rundll32", ["url.dll,FileProtocolHandler", "https://x"]]);
    const f = fake({ platform: "darwin" });
    assert.equal(openBrowser(f.ctx, new Output(f.ctx, {}), `${ORIGIN}/device?code=A&b=c`, ORIGIN), true);
    assert.deepEqual(f.spawns[0].args, [`${ORIGIN}/device?code=A&b=c`]);
    assert.equal((f.spawns[0].opts as { shell: boolean }).shell, false);
    assert.throws(() => openBrowser(f.ctx, new Output(f.ctx, {}), "https://evil.test/", ORIGIN));
    assert.equal(f.spawns.length, 1);
  });
});
