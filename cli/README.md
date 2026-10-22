# @scrolling/cli

`scrolling` is the command line for [scrolling.ai](https://scrolling.ai). With it you can make short video ads with your Creators, Swap people, products or places into an existing video, and Remake ads that work. You can use it from your terminal or from a coding agent such as Claude Code, Codex or Cursor.

```sh
npx @scrolling/cli login        # or: npm i -g @scrolling/cli
scrolling account
```

Needs Node.js 22.12 or newer. The CLI sends no telemetry.

## Log in

| Command | When to use it |
|---|---|
| `scrolling login` | A browser on this computer (OAuth with PKCE and a `127.0.0.1` redirect) |
| `scrolling login --device` | SSH, containers, or another computer: enter a code at scrolling.ai/device |
| `scrolling login --non-interactive` | Agents. Prints `{verification_url, user_code, expires_in, next}` as JSON and exits. Show the link to the person, then run `scrolling login --complete`. This mode is automatic when there is no terminal. |
| `scrolling login --read-only` | Read access only: no videos, no spending |
| `scrolling logout` | Ends the login on the server (revokes the refresh token) and removes it from this computer |
| `scrolling auth status` | Shows which credential is in use and which server it talks to |

Which credential a command uses:

1. `SCROLLING_API_KEY` (an API key from scrolling.ai settings) always wins. `auth status` warns when it is overriding a saved login.
2. Otherwise, the login saved in the system keychain (service `scrolling-cli`, account `<profile>@<server>`).
3. Otherwise, `credentials.json`, mode 0600 in a 0700 config directory. This file is used when there is no usable keychain (for example headless Linux), with a one-time warning, or when you log in with `--insecure-storage`.

The config directory is `$XDG_CONFIG_HOME/scrolling`, or `~/.config/scrolling` (`%APPDATA%\scrolling` on Windows). It holds `config.json` (profiles, never secrets), the file login if there is one, and a login started with `--non-interactive` that is waiting for approval. Access tokens refresh on their own. A lock file stops two commands from refreshing at the same time.

## Use it

```sh
scrolling account                                   # credits, plan, brands (brd_…)
scrolling creators list --brand brd_…               # Creators (cr_…)
scrolling products list --brand brd_…               # products (prd_…)
scrolling cost create --length 30 --quality 720p    # the price; nothing is spent

scrolling cost creator                              # what a new Creator costs
scrolling creators create --brand brd_… --name Mei --gender woman --energy warm,playful \
  --description 'Runs a small bakery' --yes --wait  # designed for the brand (charged, a few minutes)
scrolling creators create --brand brd_… --name Sam --from photo --photo ./sam.jpg --yes --wait
scrolling creators create --brand brd_… --name Ana --from photos --photo a.jpg --photo b.jpg   # free, ready at once

scrolling create --brand brd_… --creator cr_mei --length 30 \
  --idea 'Mei unboxes @Product 1 in her kitchen' --product prd_… --write-only   # free: idea + script
scrolling create --brand brd_… --creator cr_mei --length 30 --idea '…' --script-file script.txt --yes --wait

scrolling swap --brand brd_… --kind person --video https://www.tiktok.com/@shop/video/123 --seconds 20 --creator cr_mei --yes
scrolling swap revise swp_… --note "Make her smile more" --yes
scrolling swap approve swp_… --version 2 --quality 1080p --yes

scrolling remake --brand brd_… --video https://www.tiktok.com/@shop/video/123 --wait   # free: writes the script
scrolling remake film rmk_… --yes --wait

scrolling jobs get job_…                            # or swp_…, rmk_…, cr_…
scrolling jobs wait job_… --timeout 1200
scrolling jobs cancel job_… --yes
scrolling videos list
scrolling videos download vid_… -o ad.mp4
scrolling uploads add ./clip.mp4                    # prints a file id (u1.…) you can reuse for 7 days
```

A new Creator is made one of three ways. `--from description` (the default) designs one for the brand from your choices (`--kind`, `--gender`, `--age`, `--outfit`, up to two `--energy`, `--voice`, `--accent`) and `--description`. `--from photo` builds one from one `--photo` of a real person; how they look comes from the photo, so only `--energy`, `--voice`, `--accent` and `--description` apply. Both are charged and take a few minutes. `--from photos` uses 1 to 3 photos as they are: free and ready at once, but with no voice of its own, so it works only in Create. The job id is the new Creator's `cr_…` id: follow it with `scrolling jobs wait cr_…`, then pass it to `create --creator`. The CLI can start a Creator while fewer than 3 are being made in the account (web ones count too) and fewer than 2 by the same login or API key; otherwise it is exit 1 (`busy`), try again once one is ready. `scrolling creators create --help` lists every allowed value.

Wherever a command takes a video or a picture, you can give a local path (it is uploaded for you), an https link, or a file id. Links from TikTok, Reels, Shorts, Facebook or X are passed to Swap and Remake as they are. A Swap from such a link needs `--seconds`.

### Spending credits

Every command that spends credits gets an estimate first (`POST /api/v1/estimates`). Then:

- `--max-credits N`: goes ahead if the price is N credits or less.
- `--yes`: goes ahead at the estimated price. The quote makes the price shown the price charged.
- In a terminal, it shows the price and asks.
- Otherwise (no terminal, or `--no-input`), nothing is spent. The estimate is printed on stdout as `{confirmation_required, estimate, next}` and the command exits with 9.

Each run sends a new `Idempotency-Key`. A network retry inside the run reuses it, so a retry never starts a second job. To retry a whole run safely, pass the key it printed (`idempotency_key`) with `--idempotency-key`. Never run a spending command again to check on a job. Use `scrolling jobs wait <id>` for that.

## Output and exit codes

- stdout carries only the result: JSON with `--json`, or whenever stdout is not a terminal; readable text otherwise. Progress, hints and errors go to stderr. In JSON mode, errors are printed to stderr as `{"error":{"code","message","exit_code","details?"}}`.
- `--quiet` prints only the essential value (an id, a status) and no progress.
- There is no colour with `NO_COLOR`, `TERM=dumb`, `--no-color`, or when not on a terminal.
- `--debug` logs each request to stderr: method, URL, status and time. Tokens are cut to their prefix and last 4 characters.

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | error. Busy or rate limited: retry after `details.retry_after` seconds |
| 2 | usage: a bad flag or input |
| 3 | auth: not logged in, login expired, or not allowed |
| 4 | not found |
| 5 | duplicate: this Idempotency-Key was used for a different request |
| 6 | credits, plan or monthly credit cap. Ask the person; don't retry |
| 7 | still running (a wait timed out). Resume with `scrolling jobs wait <id>` |
| 8 | the job failed or was cancelled |
| 9 | confirmation required. Show the price, then run again with `--yes` |
| 130 | interrupted (Ctrl-C). The job keeps running |

## Global flags

`--json`, `--no-input`, `-y/--yes`, `-q/--quiet`, `--no-color`, `--profile <name>`, `--debug`. Run `scrolling <command> --help` for each command's own flags and examples.

## Environment

| Variable | |
|---|---|
| `SCROLLING_API_KEY` | API key; overrides the saved login |
| `SCROLLING_API_URL` | Server, default `https://scrolling.ai`. Plain `http://` only for `localhost`, `127.0.0.1` or `[::1]` |
| `SCROLLING_PROFILE` | Profile, like `--profile` |
| `XDG_CONFIG_HOME` | Where the config directory lives |

## Local development

Run against a local scrolling.ai server (for example on port 3005):

```sh
SCROLLING_API_URL=http://localhost:3005 scrolling login --profile local   # remembers the URL for this profile
scrolling --profile local account
# or with an API key made in the local app's settings:
SCROLLING_API_URL=http://localhost:3005 SCROLLING_API_KEY=scr_test_… scrolling account --json
```

The login pages and endpoints must be on the same origin as `SCROLLING_API_URL`. The CLI refuses a server whose discovery documents point anywhere else. So use the same host the app's `NEXT_PUBLIC_SITE_URL` / `OAUTH_ISSUER` uses (`localhost` and `127.0.0.1` count as different origins).

In this package:

```sh
npm ci
npm test          # node --test via tsx; injected fetch/fs/clock, no network
npm run typecheck
npm run build     # tsc → dist/
node dist/bin.js --help
```

From the repository root, `npm run test:cli` runs the same tests.

## Publishing

`.github/workflows/cli-publish.yml` publishes to npm with provenance (trusted publishing) when a `cli-v<version>` tag is pushed. The tag must match this `package.json` version. It has not been run yet.
