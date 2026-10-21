---
name: scrolling
description: Make short vertical video ads with scrolling.ai through the `scrolling` CLI. Create (your Creators film an idea), Swap (your Creator, product or a new place goes into a video that already works) and Remake (a fresh take on a winning ad). Use when the user wants to make, check, cancel or download scrolling.ai videos, or see their credits.
---

# scrolling CLI

**Setup**: `npm i -g @scrolling/cli` (Node 22.12+), then `scrolling login`. No browser: `scrolling login --non-interactive` prints `verification_url` and `user_code`; give both to the user, then run `scrolling login --complete`. `SCROLLING_API_KEY` also works. Making videos needs a paid plan.

**Always**
- Add `--json`; read stdout.
- Never guess ids: `account` (`brd_…`), `creators list --brand <brd>` (`cr_…`), `products list --brand <brd>` (`prd_…`).
- Price first: `cost create --length N`, `cost swap --seconds N`, `cost swap-redo <swp>`, `cost swap-hd <swp> --version N`, `cost remake-film <rmk>`. Show the credits and balance, get a yes, then run the real command with `--yes` (or `--max-credits N` for a budget).
- Spending commands return a `job_id` at once: follow it with `jobs wait <id>` or `--wait`. Never re-run one to check or retry: that pays for another video. To make a run safe to retry, pass your own `--idempotency-key <uuid>` and reuse it only for the identical command.
- Local paths upload by themselves; `uploads add <file|url>` gives a reusable file id.

**Exit codes**: 0 ok · 1 busy/rate limited, wait `retry_after` · 2 usage, see `--help` · 3 not logged in or not allowed · 4 not found · 5 key reused for another request · 6 no plan, credits or cap: tell the user, stop · 7 still running: `jobs wait` again · 8 failed or cancelled · 9 show the printed estimate, ask, re-run with `--yes` (also when the price went up after `--yes`) · 130 interrupted.

**Create**: `create --brand <brd> --creator <cr> --length 15|20|30|60 --idea '…'`, plus `--product <prd>`, `--quality 480p|720p|1080p` (default 480p; 720p+ for readable labels), `--style`, `--reference <file>` (repeatable). Up to 3 Creators, 3 products. In the idea: `@Mei`, `@Product 1`, `@Reference 1`. Only words in "double quotes" are spoken; never quote signs. Write place, camera, actions in order, the product moment, a held ending. `--write-only` writes an idea and script for free; film it with `--script-file`.

**Swap**: `swap --brand <brd> --kind person|product|both|background --video <link|file>`, plus `--creator` (in order of appearance), `--product <prd>` or `--product-photo <file>`, `--scene <preset>`/`--scene-text`, `--keep-voice`, `--keep-outfit`, `--note`. A TikTok/Reels/Shorts/Facebook/X link needs `--seconds` (4–120): swapped and charged, never past the video's own length when it can be read. A direct file link must be public `https://`. The original words stay. At stage `review`, show the draft, then `swap approve <swp> --version N --quality 480p|720p|1080p` (1080p is charged) or `swap revise <swp> --note '…'` (a new paid draft; `cost swap-redo` / `swap revise` work once the first draft is ready).

**Remake**: `remake --brand <brd> --video <link|file>` writes a script for free; show it, then `remake film <rmk>`.

**Finished**: `videos list`, `videos download <id> -o <path>`. `jobs cancel <job> --yes` stops a video being filmed.
