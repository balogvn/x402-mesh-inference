import { loadDaemonConfig, toMeshNetwork, usdcAssetId } from "@x402-mesh/shared";
import { loadOperatorKey } from "../keys.js";

/** Options for {@link addressCommand}. */
export interface AddressCommandOptions {
  env?: NodeJS.ProcessEnv;
  /** Print only the address, with no surrounding labels. Useful for shell substitution. */
  quiet?: boolean;
  /** Where to write. Defaults to `console.log`. */
  write?: (line: string) => void;
}

/**
 * Prints the Algorand address derived from `AVM_PRIVATE_KEY`.
 *
 * Only the address, the public key and the network are ever printed. The secret key is read,
 * used to derive a public key, and never rendered — not in output, not in an error message.
 */
export function addressCommand(options: AddressCommandOptions = {}): void {
  const write = options.write ?? ((line: string) => console.log(line));
  const config = loadDaemonConfig(options.env ?? process.env);
  const key = loadOperatorKey(config.privateKeyB64);

  if (options.quiet === true) {
    write(key.address);
    return;
  }

  const network = toMeshNetwork(config.network);
  write(`address:    ${key.address}`);
  write(`public key: ${key.publicKeyB64}`);
  write(`network:    ${network} (${config.network})`);
  write(`USDC ASA:   ${usdcAssetId(config.network)}`);
  write("");
  write("This address must hold ALGO for its minimum balance and be opted in to the USDC ASA");
  write("before the gateway will route paid work to this node. Run `doctor` to verify.");
}
