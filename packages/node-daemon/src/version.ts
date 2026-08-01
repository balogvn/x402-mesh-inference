/**
 * Version string this daemon advertises in registrations and heartbeats.
 *
 * Kept as a literal rather than imported from `package.json`: importing JSON would pull a
 * file outside `rootDir` into the build and change the emitted directory layout. Bump it
 * together with `packages/node-daemon/package.json`.
 */
export const DAEMON_VERSION = "0.1.0";

/** Value sent as the `user-agent` on every outbound gateway and provider call. */
export const DAEMON_USER_AGENT = `x402-mesh-node/${DAEMON_VERSION}`;
