import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { accountKey, currentCredential, KEYCHAIN_SERVICE, TokenStore, type TokenSet } from "../src/auth/store.js";
import { checkApiUrl, ensureDir, resolveSettings, saveProfileUrl, writeConfig } from "../src/config.js";
import { Output } from "../src/output.js";
import { API_KEY, fake, ORIGIN } from "./helpers.js";

const tokens = (access = "scr_at_one"): TokenSet => ({
  access_token: access,
  refresh_token: "scr_rt_one",
  expires_at: Date.UTC(2026, 9, 21, 13),
  scope: "scrolling:read scrolling:create",
  issuer: ORIGIN,
  resource: `${ORIGIN}/api/v1`,
  token_endpoint: `${ORIGIN}/api/oauth/token`,
  revocation_endpoint: `${ORIGIN}/api/oauth/revoke`,
  client_id: "scrolling-cli",
});

const mode = (p: string) => statSync(p).mode & 0o777;

describe("server URL", () => {
  test("https anywhere; plain http only on loopback hosts", () => {
    assert.equal(checkApiUrl("https://scrolling.ai/"), "https://scrolling.ai");
    assert.equal(checkApiUrl("http://localhost:3007"), "http://localhost:3007");
    assert.equal(checkApiUrl("http://127.0.0.1:3007/x"), "http://127.0.0.1:3007");
    assert.throws(() => checkApiUrl("http://scrolling.ai"), /https/);
    assert.throws(() => checkApiUrl("http://10.0.0.2:3007"), /https/);
    assert.throws(() => checkApiUrl("https://u:p@scrolling.ai"), /password/);
    assert.throws(() => checkApiUrl("ftp://scrolling.ai"), /https/);
  });

  test("SCROLLING_API_URL > the profile's saved URL > https://scrolling.ai", () => {
    const f = fake();
    assert.deepEqual(resolveSettings(f.ctx, {}).apiUrl, "https://scrolling.ai");
    saveProfileUrl(f.ctx, "local", "http://localhost:3007");
    assert.equal(resolveSettings(f.ctx, { profile: "local" }).apiUrl, "http://localhost:3007");
    assert.equal(resolveSettings(f.ctx, { profile: "local" }).apiUrlSource, "profile");
    assert.equal(resolveSettings(f.ctx, {}).apiUrl, "https://scrolling.ai");
    const e = fake({ env: { SCROLLING_API_URL: "https://staging.scrolling.ai" } });
    assert.equal(resolveSettings(e.ctx, {}).apiUrlSource, "env");
    assert.throws(() => resolveSettings(f.ctx, { profile: "../etc" }), /profile/);
  });
});

describe("files and permissions", () => {
  test("config dir 0700 (tightened if looser), files 0600", () => {
    const f = fake();
    const dir = join(f.dir, "scrolling");
    f.ctx.fs.mkdirSync(dir, { mode: 0o755 });
    f.ctx.fs.chmodSync(dir, 0o755);
    ensureDir(f.ctx);
    assert.equal(mode(dir), 0o700);
    writeConfig(f.ctx, { profiles: { default: {} } });
    assert.equal(mode(join(dir, "config.json")), 0o600);
  });

  test("credentials.json is 0600 and holds no other profile's login after logout", async () => {
    const f = fake({ keychain: "none" });
    const store = new TokenStore(f.ctx, new Output(f.ctx, {}));
    assert.equal(await store.save("a@x", tokens()), "file");
    await store.save("b@x", tokens("scr_at_two"));
    const path = join(f.dir, "scrolling", "credentials.json");
    assert.equal(mode(path), 0o600);
    await store.remove("a@x");
    assert.deepEqual(Object.keys(JSON.parse(f.ctx.fs.readFileSync(path, "utf8")) as object), ["b@x"]);
  });
});

describe("credential precedence", () => {
  const account = accountKey("default", ORIGIN);

  test("SCROLLING_API_KEY > keychain > file", async () => {
    const f = fake({ keychain: "memory" });
    const store = new TokenStore(f.ctx, new Output(f.ctx, {}));
    assert.equal(await currentCredential(f.ctx, store, account), null);
    // a file login
    await new TokenStore(f.ctx, new Output(f.ctx, {}), { insecure: true }).save(account, tokens("scr_at_file"));
    assert.equal((await currentCredential(f.ctx, store, account))?.source, "file");
    // a keychain login replaces it
    assert.equal(await new TokenStore(f.ctx, new Output(f.ctx, {})).save(account, tokens("scr_at_kc")), "keychain");
    const kc = await currentCredential(f.ctx, new TokenStore(f.ctx, new Output(f.ctx, {})), account);
    assert.equal(kc?.source, "keychain");
    assert.ok(f.keychain!.items.has(`${KEYCHAIN_SERVICE}/${account}`));
    assert.ok(!f.ctx.fs.existsSync(join(f.dir, "scrolling", "credentials.json")), "a login lives in one place");
    // the env key wins over both
    const withEnv = { ...f.ctx, env: { ...f.ctx.env, SCROLLING_API_KEY: API_KEY } };
    assert.deepEqual(await currentCredential(withEnv, store, account), { source: "env", apiKey: API_KEY });
  });

  test("no usable keychain: the file, with a warning shown once", async () => {
    const f = fake({ keychain: "broken" });
    const out = new Output(f.ctx, {});
    assert.equal(await new TokenStore(f.ctx, out).save(account, tokens()), "file");
    assert.match(f.out.stderr, /No system keychain/);
    const before = f.out.stderr.length;
    await new TokenStore(f.ctx, out).save("other@x", tokens());
    assert.equal(f.out.stderr.length, before, "warned once only");
  });

  test("--insecure-storage: the file, no warning", async () => {
    const f = fake({ keychain: "memory" });
    assert.equal(await new TokenStore(f.ctx, new Output(f.ctx, {}), { insecure: true }).save(account, tokens()), "file");
    assert.equal(f.out.stderr, "");
    assert.equal(f.keychain!.items.size, 0);
  });

  test("auth status names the source and warns when SCROLLING_API_KEY overrides a saved login", async () => {
    const f = fake({ keychain: "memory", env: { SCROLLING_API_URL: ORIGIN } });
    await new TokenStore(f.ctx, new Output(f.ctx, {})).save(account, tokens());
    assert.equal(await f.run("auth", "status"), 0);
    assert.equal(JSON.parse(f.out.stdout).source, "keychain");

    const g = fake({ keychain: "memory", env: { SCROLLING_API_URL: ORIGIN, SCROLLING_API_KEY: API_KEY } });
    await new TokenStore(g.ctx, new Output(g.ctx, {})).save(account, tokens());
    assert.equal(await g.run("auth", "status"), 0);
    const s = JSON.parse(g.out.stdout) as { source: string; overridden_login: string };
    assert.equal(s.source, "env");
    assert.equal(s.overridden_login, "keychain");
    assert.match(g.out.stderr, /Using SCROLLING_API_KEY from the environment; it overrides the login saved in the keychain/);

    const h = fake({ env: { SCROLLING_API_URL: ORIGIN } });
    assert.equal(await h.run("auth", "status"), 3);
    assert.equal(JSON.parse(h.out.stdout).logged_in, false);
  });
});
