/**
 * The host allowlist and its classification rule. This is a business rule
 * (which destinations are expected for an install/build), not I/O, so it
 * lives in domain even though the proxy that observes destinations is
 * `capture-adapter`'s. Project-wide, not per-Scan — see
 * `.hedgehog/BMAD/00-manifest.md`'s batched-round answer for the list's
 * source.
 */

export const HOST_ALLOWLIST: readonly string[] = [
  // package registries
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  // git hosts
  "github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "gitlab.com",
  "bitbucket.org",
  // common CDNs sometimes hit by postinstall scripts
  "cdn.jsdelivr.net",
  "unpkg.com",
];

/**
 * True when `host` is on the allowlist, or is a subdomain of an
 * allowlisted host (e.g. `objects.githubusercontent.com` is not
 * automatically allowed by `github.com` — only exact matches and explicit
 * suffix entries count. No implicit subdomain widening: an allowlist entry
 * must name exactly the host it covers).
 */
export function isAllowedHost(host: string, allowlist: readonly string[] = HOST_ALLOWLIST): boolean {
  const normalized = host.trim().toLowerCase();
  return allowlist.some((entry) => entry.toLowerCase() === normalized);
}

/**
 * Classify one observed destination against the allowlist. Returns the
 * Finding to report, or `undefined` when the destination is expected and
 * contributes no Finding.
 */
export function classifyDestination(
  host: string,
  producedBy: "proxy-start" | "classify",
  allowlist: readonly string[] = HOST_ALLOWLIST,
): { kind: "network"; detail: string; producedBy: typeof producedBy } | undefined {
  if (isAllowedHost(host, allowlist)) {
    return undefined;
  }
  return { kind: "network", detail: host, producedBy };
}
