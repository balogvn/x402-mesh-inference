/**
 * Shared terminal plumbing for the `scripts/` entry points.
 *
 * Deliberately dependency-free: these scripts are the first thing an operator runs, often
 * before `npm run build`, so they must work with node builtins and the packages already
 * installed. Nothing here ever formats a secret.
 */

/** Outcome of a single preflight/e2e check. */
export type CheckStatus = "pass" | "fail" | "warn" | "skip";

/** One rendered line of a pass/fail checklist. */
export interface CheckResult {
  status: CheckStatus;
  /** Short, stable label. Keep it greppable — CI logs are read with the eye, not a parser. */
  name: string;
  /** Optional one-line explanation. Must never contain key material. */
  detail?: string;
}

const COLOR_ENABLED =
  process.env["NO_COLOR"] === undefined &&
  process.env["TERM"] !== "dumb" &&
  process.stdout.isTTY === true;

const CODES = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
} as const;

function paint(code: keyof typeof CODES, text: string): string {
  return COLOR_ENABLED ? `${CODES[code]}${text}${CODES.reset}` : text;
}

export const style = {
  bold: (t: string) => paint("bold", t),
  dim: (t: string) => paint("dim", t),
  red: (t: string) => paint("red", t),
  green: (t: string) => paint("green", t),
  yellow: (t: string) => paint("yellow", t),
  cyan: (t: string) => paint("cyan", t),
};

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: paint("green", "PASS"),
  fail: paint("red", "FAIL"),
  warn: paint("yellow", "WARN"),
  skip: paint("dim", "SKIP"),
};

/**
 * An ordered pass/fail checklist.
 *
 * Results are printed as they are recorded so that a script which hangs on a network call
 * still shows what already succeeded, and summarized at the end.
 */
export class Checklist {
  private readonly results: CheckResult[] = [];

  constructor(private readonly title: string) {
    process.stdout.write(`\n${style.bold(title)}\n\n`);
  }

  /** Records and immediately prints one result. */
  record(status: CheckStatus, name: string, detail?: string): void {
    const result: CheckResult = detail === undefined ? { status, name } : { status, name, detail };
    this.results.push(result);
    const suffix = detail === undefined ? "" : ` ${style.dim(`- ${detail}`)}`;
    process.stdout.write(`  ${STATUS_LABEL[status]}  ${name}${suffix}\n`);
  }

  pass(name: string, detail?: string): void {
    this.record("pass", name, detail);
  }

  fail(name: string, detail?: string): void {
    this.record("fail", name, detail);
  }

  warn(name: string, detail?: string): void {
    this.record("warn", name, detail);
  }

  skip(name: string, detail?: string): void {
    this.record("skip", name, detail);
  }

  /** True when at least one check failed. */
  get failed(): boolean {
    return this.results.some((r) => r.status === "fail");
  }

  /** Prints the tally and returns the process exit code to use. */
  summarize(): number {
    const tally = { pass: 0, fail: 0, warn: 0, skip: 0 };
    for (const r of this.results) tally[r.status] += 1;
    const line =
      `${tally.pass} passed, ${tally.fail} failed, ` +
      `${tally.warn} warnings, ${tally.skip} skipped`;
    process.stdout.write(`\n  ${style.bold(this.title)}: ${line}\n\n`);
    return this.failed ? 1 : 0;
  }
}

/** Prints a section heading. */
export function heading(text: string): void {
  process.stdout.write(`\n${style.bold(text)}\n`);
}

/** Prints an informational line, indenting every line of a multi-line string. */
export function info(text: string): void {
  const body = text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `  ${line}`))
    .join("\n");
  process.stdout.write(`${body}\n`);
}

/**
 * Prints a loud, unmissable warning box on stderr.
 *
 * Used where a mistake costs real money or leaks a key, so it must survive being skimmed.
 */
export function banner(lines: string[], tone: "danger" | "notice" = "danger"): void {
  const width = Math.max(...lines.map((l) => l.length), 60);
  const bar = "!".repeat(width + 4);
  const color = tone === "danger" ? style.red : style.yellow;
  const body = lines.map((l) => `! ${l.padEnd(width)} !`).join("\n");
  process.stderr.write(`\n${color(bar)}\n${color(body)}\n${color(bar)}\n\n`);
}

/** Extracts a readable message from an unknown throwable without leaking a stack. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Parsed command line: `--flag`, `--key value` and `--key=value` are all accepted. */
export interface ParsedArgs {
  flags: Set<string>;
  options: Map<string, string>;
  positionals: string[];
}

/** Minimal argv parser. No dependency, no surprises, no implicit type coercion. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      options.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(body, next);
      i += 1;
    } else {
      flags.add(body);
    }
  }
  return { flags, options, positionals };
}

/** True when the caller asked for usage. */
export function wantsHelp(args: ParsedArgs): boolean {
  return args.flags.has("help") || args.flags.has("h") || args.positionals.includes("help");
}

/** Default timeout for every outbound HTTP call made by a script. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** A non-2xx HTTP response from a script's outbound call. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = "HttpError";
  }
}

/**
 * `fetch` with a hard timeout and a bounded error body.
 *
 * A script that hangs forever on an unreachable facilitator is worse than one that fails, so
 * every request carries a deadline.
 */
export async function httpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const response = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 512);
    throw new HttpError(response.status, url, body);
  }
  return (await response.json()) as T;
}

/**
 * Redacts a secret for display: keeps a short prefix so an operator can tell two keys apart,
 * and nothing else. Used for log lines that must prove a key was *loaded*, never what it is.
 */
export function redact(secret: string): string {
  if (secret.length <= 8) return "[redacted]";
  return `${secret.slice(0, 4)}…[redacted, ${secret.length} chars]`;
}
