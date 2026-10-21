import type { Context, OutStream } from "./context.js";
import { CliError } from "./exit-codes.js";

/**
 * What goes where. stdout carries the result only (JSON with --json or whenever stdout is not a
 * terminal; readable text otherwise); everything else (progress, hints, warnings, errors) goes
 * to stderr. Colour only on a terminal, never with NO_COLOR, TERM=dumb or --no-color.
 */

export type GlobalOptions = {
  json?: boolean;
  /** false with --no-input */
  input?: boolean;
  yes?: boolean;
  quiet?: boolean;
  /** false with --no-color */
  color?: boolean;
  profile?: string;
  debug?: boolean;
  insecureStorage?: boolean;
};

const SECRET = /\b(scr_(?:live|test|at|rt|dc)_)[A-Za-z0-9]+/g;
const SEALED = /\b(up1|u1|q1)\.[A-Za-z0-9._~-]+/g;
const QUERY_SECRET = /([?&](?:code|state|code_verifier|token|device_code|refresh_token|access_token)=)[^&\s#]+/gi;

const last4 = (s: string) => s.slice(-4);

/** Tokens, sealed ids and secret query parameters cut down to their prefix and last 4 characters. */
export function redact(text: string): string {
  return text
    .replace(SECRET, (m, prefix: string) => `${prefix}…${last4(m)}`)
    .replace(SEALED, (m, prefix: string) => `${prefix}.…${last4(m)}`)
    .replace(QUERY_SECRET, (_m, key: string) => `${key}…`);
}

function colorOk(ctx: Context, stream: OutStream, wanted: boolean | undefined): boolean {
  if (wanted === false) return false;
  if ((ctx.env.NO_COLOR ?? "") !== "") return false;
  if (ctx.env.TERM === "dumb") return false;
  return !!stream.isTTY;
}

export type ResultFormat<T> = {
  /** Readable text for a terminal (default: an indented key: value listing). */
  human?: (data: T) => string;
  /** The bare value --quiet prints (default: nothing extra beyond the human text). */
  quiet?: (data: T) => string;
};

export class Output {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly debugOn: boolean;
  private readonly colorOut: boolean;
  private readonly colorErr: boolean;

  constructor(
    private readonly ctx: Context,
    opts: GlobalOptions,
  ) {
    this.json = !!opts.json || !ctx.stdout.isTTY;
    this.quiet = !!opts.quiet;
    this.debugOn = !!opts.debug;
    this.colorOut = !this.json && colorOk(ctx, ctx.stdout, opts.color);
    this.colorErr = colorOk(ctx, ctx.stderr, opts.color);
  }

  /** Whether the person can be asked something (stdin and stderr are terminals). */
  interactive(opts: GlobalOptions): boolean {
    return opts.input !== false && !!this.ctx.stdin.isTTY && !!this.ctx.stderr.isTTY;
  }

  result<T>(data: T, fmt: ResultFormat<T> = {}): void {
    if (this.json) {
      this.ctx.stdout.write(JSON.stringify(data, null, 2) + "\n");
      return;
    }
    if (this.quiet && fmt.quiet) {
      const q = fmt.quiet(data);
      if (q) this.ctx.stdout.write(q + "\n");
      return;
    }
    const text = fmt.human ? fmt.human(data) : toHuman(data);
    if (text) this.ctx.stdout.write(text.endsWith("\n") ? text : text + "\n");
  }

  /** A status line on stderr (hidden with --quiet). */
  info(message: string): void {
    if (!this.quiet) this.ctx.stderr.write(message + "\n");
  }

  /** Always shown, on stderr. */
  warn(message: string): void {
    this.ctx.stderr.write(this.paintErr("33", "Warning: ") + message + "\n");
  }

  success(message: string): void {
    if (!this.quiet) this.ctx.stderr.write(this.paintErr("32", "✓ ") + message + "\n");
  }

  /** A progress line: rewritten in place on a terminal, plain lines otherwise. */
  progress(line: string): void {
    if (this.quiet) return;
    if (this.ctx.stderr.isTTY) this.ctx.stderr.write(`\r\x1b[2K${line}`);
    else this.ctx.stderr.write(line + "\n");
  }

  /** Ends a run of progress() lines on a terminal. */
  progressDone(): void {
    if (!this.quiet && this.ctx.stderr.isTTY) this.ctx.stderr.write("\n");
  }

  debug(message: string): void {
    if (this.debugOn) this.ctx.stderr.write(`[debug] ${redact(message)}\n`);
  }

  /** An error on stderr: one JSON object in JSON mode, a line of text otherwise. */
  error(e: CliError): void {
    if (this.json) {
      const body = { error: { code: e.code, message: e.message, exit_code: e.exitCode, ...(e.details ? { details: e.details } : {}) } };
      this.ctx.stderr.write(JSON.stringify(body) + "\n");
      return;
    }
    this.ctx.stderr.write(this.paintErr("31", "Error: ") + e.message + "\n");
    const retry = e.details?.retry_after;
    if (typeof retry === "number") this.ctx.stderr.write(`Try again in ${retry} s.\n`);
  }

  paint(code: string, text: string): string {
    return this.colorOut ? `\x1b[${code}m${text}\x1b[0m` : text;
  }

  private paintErr(code: string, text: string): string {
    return this.colorErr ? `\x1b[${code}m${text}\x1b[0m` : text;
  }
}

/** A plain indented listing of any JSON value (the default terminal format). */
export function toHuman(value: unknown, indent = ""): string {
  if (value === null || value === undefined) return `${indent}-`;
  if (typeof value !== "object") return `${indent}${String(value)}`;
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}(none)`;
    return value
      .map((v) => {
        if (v && typeof v === "object") return `${indent}-\n${toHuman(v, indent + "  ")}`;
        return `${indent}- ${String(v)}`;
      })
      .join("\n");
  }
  const lines: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v && typeof v === "object" && (!Array.isArray(v) || v.length)) lines.push(`${indent}${k}:\n${toHuman(v, indent + "  ")}`);
    else lines.push(`${indent}${k}: ${Array.isArray(v) ? "(none)" : v === null || v === undefined ? "-" : String(v)}`);
  }
  return lines.join("\n");
}

/** Rows as aligned columns. */
export function table(rows: readonly (readonly string[])[], header?: readonly string[]): string {
  const all = header ? [header, ...rows] : rows;
  if (!all.length) return "(none)";
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all.map((r) => r.map((c, i) => (i === r.length - 1 ? c : (c ?? "").padEnd(widths[i]))).join("  ")).join("\n");
}
