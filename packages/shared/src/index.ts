/**
 * `@x402-mesh/shared` — the contract layer every other mesh package compiles against.
 *
 * This package must never import from `@x402-mesh/gateway`, `@x402-mesh/registry` or
 * `@x402-mesh/node-daemon`: it sits underneath all three.
 */
export * from "./errors.js";
export * from "./networks.js";
export * from "./money.js";
export * from "./pricing.js";
export * from "./types.js";
export * from "./schemas.js";
export * from "./signing.js";
export * from "./net-guard.js";
export * from "./config.js";
