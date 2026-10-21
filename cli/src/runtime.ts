import { currentCredential, accountKey, TokenStore } from "./auth/store.js";
import { apiKeyAuth, OAuthSession } from "./auth/tokens.js";
import { resolveSettings, type Settings } from "./config.js";
import type { Context } from "./context.js";
import { authError } from "./exit-codes.js";
import { Api } from "./http.js";
import { Output, type GlobalOptions } from "./output.js";

/** What every command runs with: the context, the global flags, output, settings, the login and the API client. */
export type Runtime = {
  ctx: Context;
  opts: GlobalOptions;
  out: Output;
  settings: Settings;
  store: TokenStore;
  /** "<profile>@<origin>": where this profile's login is kept. */
  account: string;
  /** The API client, signed in (SCROLLING_API_KEY or the saved login); exit 3 when there is neither. */
  api(): Promise<Api>;
};

export function createRuntime(ctx: Context, opts: GlobalOptions, out = new Output(ctx, opts)): Runtime {
  const settings = resolveSettings(ctx, opts);
  const store = new TokenStore(ctx, out, { insecure: opts.insecureStorage });
  const account = accountKey(settings.profile, settings.apiUrl);
  let api: Api | null = null;
  return {
    ctx,
    opts,
    out,
    settings,
    store,
    account,
    async api() {
      if (api) return api;
      const cred = await currentCredential(ctx, store, account);
      if (!cred) throw authError(`You're not logged in to ${settings.apiUrl}. Run \`scrolling login\` (or set SCROLLING_API_KEY).`, "not_logged_in");
      const auth = cred.source === "env" ? apiKeyAuth(cred.apiKey) : new OAuthSession(ctx, out, store, account, cred.tokens);
      api = new Api(ctx, out, settings.apiUrl, auth);
      return api;
    },
  };
}
