import { Command, CommanderError } from "commander";
import { registerAccount } from "./commands/account.js";
import { registerAuth } from "./commands/auth.js";
import { registerBrands } from "./commands/brands.js";
import { registerCost } from "./commands/cost.js";
import { registerCreate } from "./commands/create.js";
import { registerCreators } from "./commands/creators.js";
import { registerJobs } from "./commands/jobs.js";
import { registerProducts } from "./commands/products.js";
import { registerRemake } from "./commands/remake.js";
import { registerSwap } from "./commands/swap.js";
import { registerUploads } from "./commands/uploads.js";
import { registerVideos } from "./commands/videos.js";
import { isAbort, type Context } from "./context.js";
import { CliError, EXIT } from "./exit-codes.js";
import { Output, type GlobalOptions } from "./output.js";

const HELP_AFTER = `
Version: scrolling --version

Getting started:
  $ scrolling login
  $ scrolling account                         # credits and brands (brd_…)
  $ scrolling creators list --brand brd_…     # Creators (cr_…)
  $ scrolling cost create --length 30         # the price, nothing spent
  $ scrolling create --brand brd_… --creator cr_… --length 30 --idea '…' --wait

For agents: add --json (automatic when stdout isn't a terminal). Spending commands never ask
without a terminal: they print the estimate and exit 9 until run with --yes or --max-credits.
Never run a spending command again to check on a job: use \`scrolling jobs wait <id>\`.

Environment:
  SCROLLING_API_KEY   an API key (overrides the saved login; for CI and agents)
  SCROLLING_API_URL   the server (default https://scrolling.ai; http only for localhost)
  SCROLLING_PROFILE   the profile (like --profile)
  NO_COLOR            no colours

Exit codes:
  0 ok · 1 error (busy/rate limited: retry later) · 2 usage · 3 auth · 4 not found
  5 duplicate idempotency key · 6 credits/plan/credit cap · 7 still running
  8 job failed · 9 confirmation required · 130 interrupted`;

export function buildProgram(ctx: Context): Command {
  const program = new Command("scrolling");
  program
    .description("scrolling.ai from the terminal: video ads with your Creators, Swaps and Remakes")
    .option("--json", "print JSON (automatic when stdout isn't a terminal)")
    .option("--no-input", "never ask anything (spending without --yes exits 9)")
    .option("-y, --yes", "confirm the price and go ahead")
    .option("-q, --quiet", "print only the essential value; no progress")
    .option("--no-color", "no colours")
    .option("--profile <name>", "use another saved login/server (default: default)")
    .option("--debug", "log requests to stderr (tokens redacted)")
    .exitOverride()
    .showSuggestionAfterError()
    .configureOutput({
      writeOut: (s) => void ctx.stdout.write(s),
      writeErr: (s) => void ctx.stderr.write(s),
    })
    .addHelpText("after", HELP_AFTER);

  registerAuth(program, ctx);
  registerAccount(program, ctx);
  registerBrands(program, ctx);
  registerCreators(program, ctx);
  registerProducts(program, ctx);
  registerUploads(program, ctx);
  registerCost(program, ctx);
  registerCreate(program, ctx);
  registerSwap(program, ctx);
  registerRemake(program, ctx);
  registerJobs(program, ctx);
  registerVideos(program, ctx);
  return program;
}

/** Runs the CLI on `argv` (user arguments only) and returns the exit code. Never calls process.exit. */
export async function run(argv: readonly string[], ctx: Context): Promise<number> {
  const program = buildProgram(ctx);
  if (!argv.length) {
    program.outputHelp();
    return EXIT.ok;
  }
  // Only as the first argument: `--version <n>` is also a Swap version further on.
  if (argv[0] === "--version" || argv[0] === "-v") {
    ctx.stdout.write(ctx.version + "\n");
    return EXIT.ok;
  }
  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT.ok;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed") return EXIT.ok;
      return e.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    const out = new Output(ctx, safeOpts(program));
    const err = e instanceof CliError ? e : isAbort(e) ? new CliError("Interrupted.", EXIT.interrupted, "interrupted") : unexpected(e, out);
    out.error(err);
    return err.exitCode;
  }
}

function safeOpts(program: Command): GlobalOptions {
  try {
    return program.opts() as GlobalOptions;
  } catch {
    return {};
  }
}

function unexpected(e: unknown, out: Output): CliError {
  out.debug(e instanceof Error ? (e.stack ?? e.message) : String(e));
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") return new CliError(`Permission denied: ${(e as NodeJS.ErrnoException).path ?? "a file"}.`, EXIT.error, "permission_denied");
  return new CliError(`Something went wrong${e instanceof Error ? `: ${e.message}` : ""}. Run again with --debug for details.`, EXIT.error, "internal");
}
