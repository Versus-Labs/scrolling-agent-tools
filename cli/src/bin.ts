#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { run } from "./cli.js";
import { realContext } from "./context.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

// First Ctrl-C: stop what's running (waits print how to resume) and exit 130. Second: exit now.
const controller = new AbortController();
process.on("SIGINT", () => {
  if (controller.signal.aborted) process.exit(130);
  controller.abort();
});

const code = await run(process.argv.slice(2), realContext(version, controller.signal));
process.exitCode = code;
