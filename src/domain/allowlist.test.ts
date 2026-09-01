import { describe, expect, it } from "vitest";
import { classifyDestination, HOST_ALLOWLIST, isAllowedHost } from "./allowlist.js";

describe("isAllowedHost", () => {
  it("accepts every host on the default allowlist", () => {
    for (const host of HOST_ALLOWLIST) {
      expect(isAllowedHost(host)).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isAllowedHost("REGISTRY.NPMJS.ORG")).toBe(true);
  });

  it("rejects a host not on the allowlist", () => {
    expect(isAllowedHost("evil.example.com")).toBe(false);
  });

  it("does not implicitly allow subdomains of an allowlisted host", () => {
    expect(isAllowedHost("objects.githubusercontent.com")).toBe(false);
  });

  it("respects an injected allowlist over the default", () => {
    expect(isAllowedHost("example.com", ["example.com"])).toBe(true);
    expect(isAllowedHost("registry.npmjs.org", ["example.com"])).toBe(false);
  });
});

describe("classifyDestination", () => {
  it("produces no finding for an allowlisted host", () => {
    expect(classifyDestination("github.com", "classify")).toBeUndefined();
  });

  it("produces a network finding for a non-allowlisted host, tagged with the producing step", () => {
    expect(classifyDestination("telemetry.example.com", "classify")).toEqual({
      kind: "network",
      detail: "telemetry.example.com",
      producedBy: "classify",
    });
  });
});
