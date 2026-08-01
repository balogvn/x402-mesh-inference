import { beforeEach, describe, expect, it } from "vitest";

import {
  assertHttpUrlShape,
  assertRoutableEndpoint,
  isBlockedAddress,
  resetEndpointValidationCache,
  ValidationError,
} from "../src/index.js";

/** A resolver stub that always returns the given addresses. */
function resolvesTo(...addresses: string[]) {
  return async () => addresses;
}

beforeEach(() => {
  resetEndpointValidationCache();
});

describe("isBlockedAddress", () => {
  it.each([
    ["169.254.169.254", "cloud instance metadata"],
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "RFC1918 /8"],
    ["172.16.0.1", "RFC1918 /12"],
    ["172.31.255.254", "RFC1918 /12 upper bound"],
    ["192.168.1.1", "RFC1918 /16"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["0.0.0.0", "this network"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([["8.8.8.8"], ["1.1.1.1"], ["172.32.0.1"], ["100.128.0.1"], ["93.184.216.34"]])(
    "allows public address %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it.each([
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fe80::1", "link-local"],
    ["fc00::1", "unique-local"],
    ["fd12:3456::1", "unique-local"],
    ["ff02::1", "multicast"],
  ])("blocks IPv6 %s (%s)", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 forms of a private address", () => {
    // ::ffff:169.254.169.254 reaches metadata just as well as the bare v4 literal, so the
    // guard has to unwrap the mapping rather than treat it as an opaque v6 address.
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("allows a public IPv6 address", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("treats a non-IP string as blocked, since it must be resolved first", () => {
    expect(isBlockedAddress("example.com")).toBe(true);
  });
});

describe("assertHttpUrlShape", () => {
  it("rejects non-http schemes", () => {
    expect(() => assertHttpUrlShape("file:///etc/passwd")).toThrow(ValidationError);
    expect(() => assertHttpUrlShape("gopher://x/")).toThrow(ValidationError);
  });

  it("rejects a URL embedding credentials", () => {
    expect(() => assertHttpUrlShape("http://user:pass@example.com")).toThrow(/credentials/);
  });

  it("rejects a malformed URL", () => {
    expect(() => assertHttpUrlShape("not a url")).toThrow(ValidationError);
  });

  it("accepts a plain https URL", () => {
    expect(assertHttpUrlShape("https://node.example.com:8443/x").host).toBe(
      "node.example.com:8443",
    );
  });
});

describe("assertRoutableEndpoint", () => {
  it("rejects a literal cloud-metadata endpoint", async () => {
    await expect(
      assertRoutableEndpoint("http://169.254.169.254/latest/meta-data", {
        resolve: resolvesTo(),
      }),
    ).rejects.toThrow(/non-public address/);
  });

  it("rejects a hostname that resolves to a private address", async () => {
    await expect(
      assertRoutableEndpoint("http://sneaky.example.com", {
        resolve: resolvesTo("10.0.0.5"),
      }),
    ).rejects.toThrow(/non-public address/);
  });

  it("rejects when only ONE of several resolved addresses is private", async () => {
    // Which address the OS picks is outside our control, so a single private answer is
    // enough to make the endpoint unsafe.
    await expect(
      assertRoutableEndpoint("http://split.example.com", {
        resolve: resolvesTo("93.184.216.34", "169.254.169.254"),
      }),
    ).rejects.toThrow(/non-public address/);
  });

  it("rejects a hostname that resolves to nothing", async () => {
    await expect(
      assertRoutableEndpoint("http://void.example.com", { resolve: resolvesTo() }),
    ).rejects.toThrow(/could not be resolved/);
  });

  it("accepts a hostname resolving only to public addresses", async () => {
    const url = await assertRoutableEndpoint("https://node.example.com", {
      resolve: resolvesTo("93.184.216.34"),
    });
    expect(url.host).toBe("node.example.com");
  });

  it("allows private addresses when explicitly opted in", async () => {
    const url = await assertRoutableEndpoint("http://127.0.0.1:11434", { allowPrivate: true });
    expect(url.port).toBe("11434");
  });

  it("caches a successful validation, then re-resolves once the TTL lapses", async () => {
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return ["93.184.216.34"];
    };
    let clock = 1_000;
    const now = () => clock;

    await assertRoutableEndpoint("https://cached.example.com", { resolve, now });
    await assertRoutableEndpoint("https://cached.example.com", { resolve, now });
    expect(calls).toBe(1);

    clock += 60_000; // past the 30s TTL
    await assertRoutableEndpoint("https://cached.example.com", { resolve, now });
    expect(calls).toBe(2);
  });
});
