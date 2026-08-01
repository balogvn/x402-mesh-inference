#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { MeshError, UsdcAmountSchema } from "@x402-mesh/shared";
import { addressCommand } from "./commands/address.js";
import { doctorCommand } from "./commands/doctor.js";
import { registerCommand } from "./commands/register.js";
import { startCommand } from "./commands/start.js";
import type { CapabilityOverrides } from "./registration.js";
import { DAEMON_VERSION } from "./version.js";

/**
 * `x402-mesh-node` — the CLI a GPU operator runs.
 *
 * Configuration comes from the environment (see `loadDaemonConfig`); flags only cover things
 * that are per-invocation rather than per-deployment. The private key is read from
 * `AVM_PRIVATE_KEY` and deliberately has no flag: a key passed on the command line ends up in
 * the shell history and in `ps` output.
 */

/** Parses an integer option, rejecting anything that is not an exact decimal integer. */
function integerOption(name: string, min: number, max: number) {
  return (raw: string): number => {
    if (!/^\d+$/.test(raw)) {
      throw new InvalidArgumentError(`${name} must be a positive integer`);
    }
    const value = Number(raw);
    if (value < min || value > max) {
      throw new InvalidArgumentError(`${name} must be between ${min} and ${max}`);
    }
    return value;
  };
}

/** Parses a decimal USDC option using the shared money validator — never `parseFloat`. */
function usdcOption(name: string) {
  return (raw: string): string => {
    const result = UsdcAmountSchema.safeParse(raw);
    if (!result.success) {
      throw new InvalidArgumentError(
        `${name} must be a non-negative decimal USDC amount with at most 6 decimal places`,
      );
    }
    return raw;
  };
}

/** Flags shared by the commands that build a registration. */
interface CapabilityFlags {
  contextWindow?: number;
  price?: string;
  quantization?: string;
}

function capabilityOverrides(flags: CapabilityFlags): CapabilityOverrides {
  const overrides: CapabilityOverrides = {};
  if (flags.contextWindow !== undefined) overrides.contextWindow = flags.contextWindow;
  if (flags.price !== undefined) overrides.pricePer1kTokensUsdc = flags.price;
  if (flags.quantization !== undefined) overrides.quantization = flags.quantization;
  return overrides;
}

function withCapabilityFlags(command: Command): Command {
  return command
    .option(
      "--context-window <tokens>",
      "context window advertised for every model",
      integerOption("--context-window", 1, 10_000_000),
    )
    .option(
      "--price <usdc>",
      "decimal USDC quoted per 1000 tokens, e.g. 0.0017",
      usdcOption("--price"),
    )
    .option("--quantization <label>", "quantization label advertised for every model");
}

/** Builds the command tree. Exported so tests can render help without spawning a process. */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("x402-mesh-node")
    .description(
      "x402 Mesh node daemon: register a GPU with the mesh gateway, prove liveness with " +
        "signed heartbeats, and serve paid inference.",
    )
    .version(DAEMON_VERSION, "-v, --version", "print the daemon version")
    .showHelpAfterError()
    .addHelpText(
      "after",
      [
        "",
        "Environment (required):",
        "  MESH_GATEWAY_URL       base URL of the mesh gateway",
        "  MESH_NODE_ID           stable id for this node, unique within the mesh",
        "  MESH_NODE_ENDPOINT     absolute URL the gateway forwards inference to",
        "  MESH_MODELS            comma-separated models this node serves",
        "  AVM_PRIVATE_KEY        base64 of the 64-byte Algorand secret key (never a flag)",
        "",
        "Environment (optional):",
        "  MESH_PROVIDER          ollama | vllm | openai            (default: ollama)",
        "  MESH_PROVIDER_BASE_URL backend base URL                  (default: per provider)",
        "  MESH_PROVIDER_API_KEY  bearer token for the backend, if it needs one",
        "  MESH_NETWORK           mainnet | testnet                 (default: testnet)",
        "  MESH_MAX_CONCURRENCY   concurrent requests before 503    (default: 8)",
        "  MESH_HEARTBEAT_INTERVAL_MS                               (default: 15000)",
        "  MESH_NODE_AUTH_TOKEN   bearer token the gateway must present on POST /infer",
        "",
        "Run `x402-mesh-node doctor` first: it checks the backend, the key, the gateway and",
        "the on-chain USDC opt-in that payouts depend on.",
      ].join("\n"),
    );

  withCapabilityFlags(
    program
      .command("register")
      .description("register this node with the gateway once, then exit")
      .option(
        "--max-attempts <n>",
        "attempts before giving up",
        integerOption("--max-attempts", 1, 20),
      ),
  ).action(async (flags: CapabilityFlags & { maxAttempts?: number }) => {
    const options: Parameters<typeof registerCommand>[0] = capabilityOverrides(flags);
    if (flags.maxAttempts !== undefined) options.maxAttempts = flags.maxAttempts;
    await registerCommand(options);
  });

  withCapabilityFlags(
    program
      .command("start")
      .description("register, start the signed heartbeat and serve inference")
      .option(
        "--port <port>",
        "listen port (default: the port in MESH_NODE_ENDPOINT)",
        integerOption("--port", 1, 65_535),
      )
      .option("--host <host>", "listen host", "0.0.0.0")
      .option("--no-register", "skip the initial registration (node is already registered)")
      .option("--log-level <level>", "pino log level", "info"),
  ).action(
    async (
      flags: CapabilityFlags & {
        port?: number;
        host?: string;
        register?: boolean;
        logLevel?: string;
      },
    ) => {
      const options: Parameters<typeof startCommand>[0] = capabilityOverrides(flags);
      if (flags.port !== undefined) options.port = flags.port;
      if (flags.host !== undefined) options.host = flags.host;
      if (flags.logLevel !== undefined) options.logLevel = flags.logLevel;
      // `--no-register` sets `register` to false; commander leaves it `true` otherwise.
      if (flags.register === false) options.skipRegister = true;
      // Secrets come from the environment only, never from argv.
      const authToken = process.env["MESH_NODE_AUTH_TOKEN"];
      if (authToken !== undefined && authToken.length > 0) options.authToken = authToken;
      const providerApiKey = process.env["MESH_PROVIDER_API_KEY"];
      if (providerApiKey !== undefined && providerApiKey.length > 0) {
        options.providerApiKey = providerApiKey;
      }

      const daemon = await startCommand(options);
      await waitForShutdown(daemon.stop);
    },
  );

  program
    .command("doctor")
    .description("diagnose this node's configuration, backend, key and on-chain prerequisites")
    .option("--offline", "skip every check that touches the network")
    .option("--algod-url <url>", "algod base URL (default: public AlgoNode for the network)")
    .action(async (flags: { offline?: boolean; algodUrl?: string }) => {
      const options: Parameters<typeof doctorCommand>[0] = {};
      if (flags.offline === true) options.offline = true;
      if (flags.algodUrl !== undefined) options.algod = { baseUrl: flags.algodUrl };
      // Same secret `start` uses. Diagnosing the backend without it probes a different
      // system than the one that will actually serve traffic.
      const doctorApiKey = process.env["MESH_PROVIDER_API_KEY"];
      if (doctorApiKey !== undefined && doctorApiKey.length > 0) {
        options.providerApiKey = doctorApiKey;
      }
      const report = await doctorCommand(options);
      if (!report.ok) process.exitCode = 1;
    });

  program
    .command("address")
    .description("print the operator address derived from AVM_PRIVATE_KEY (never the key)")
    .option("--quiet", "print only the address, for shell substitution")
    .action((flags: { quiet?: boolean }) => {
      addressCommand(flags.quiet === true ? { quiet: true } : {});
    });

  return program;
}

/**
 * Blocks until SIGINT or SIGTERM, then shuts the daemon down.
 *
 * Both handlers are removed once one fires, so a second Ctrl-C is handled by Node's default
 * (immediate exit) — an operator holding a wedged shutdown should not have to find the PID.
 */
function waitForShutdown(stop: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      console.log(`received ${signal}, shutting down`);
      stop().then(resolve, reject);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

/**
 * Parses `argv` and runs the selected command.
 *
 * Mesh errors are printed as one actionable line rather than a stack trace: the operator
 * needs to know which variable or prerequisite is wrong, and `MeshError.toJSON` has already
 * redacted anything secret-looking from the details.
 *
 * @param argv - Full process argv. Defaults to `process.argv`.
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (cause) {
    if (cause instanceof MeshError) {
      console.error(`error [${cause.code}]: ${cause.message}`);
      const details = cause.toJSON().error.details;
      if (details !== undefined) console.error(JSON.stringify(details));
    } else if (cause instanceof Error) {
      console.error(`error: ${cause.message}`);
    } else {
      console.error(`error: ${String(cause)}`);
    }
    process.exitCode = 1;
  }
}

// `import.meta.url` matches only when this file is the entry point, so importing the CLI from
// a test does not start a daemon. `pathToFileURL` (rather than string concatenation) is what
// makes the comparison correct for paths containing spaces.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
