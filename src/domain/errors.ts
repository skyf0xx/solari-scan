/**
 * Domain-level typed errors. `sandbox-adapter` and `capture-adapter` map
 * whatever the real Solari SDK / filesystem / proxy throws onto these —
 * domain never depends on Solari's own error shapes (`@solarisdk/core`'s
 * `GatewayError`, `ConcurrencyLimitError`, etc.), only on this vocabulary.
 * `command` is the only layer allowed to turn one of these into a
 * user-facing message and exit code.
 */

export type ScanErrorKind =
  | "sandbox-provisioning"
  | "sandbox-capacity"
  | "sandbox-credit-exhaustion"
  | "clone-failure"
  | "package-manager-undetected";

export abstract class ScanError extends Error {
  abstract readonly kind: ScanErrorKind;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The sandbox could not be created or reached (transport/API failure, not capacity). */
export class SandboxProvisioningError extends ScanError {
  readonly kind = "sandbox-provisioning" as const;
}

/**
 * No sandbox capacity available right now — the free tier's
 * concurrent-sandbox limit is already in use. Distinct from credit
 * exhaustion: this is a transient slot problem, not a billing one.
 */
export class SandboxCapacityError extends ScanError {
  readonly kind = "sandbox-capacity" as const;
}

/** The account's Solari credits are exhausted. */
export class SandboxCreditExhaustionError extends ScanError {
  readonly kind = "sandbox-credit-exhaustion" as const;
}

/**
 * Cloning the target repo/PR failed (bad URL, missing PR, auth failure,
 * network failure during clone). Distinct from install/build failure,
 * which is not an error at all — the Scan is expected to continue past it.
 */
export class CloneError extends ScanError {
  readonly kind = "clone-failure" as const;
}

/**
 * No known package manager marker file (package.json, package-lock.json)
 * was found at the repo root, so no install/build command can be
 * chosen. Distinct from an install/build command failing after it runs —
 * this is domain refusing to guess a command RELEVANT RULES doesn't name.
 */
export class PackageManagerUndetectedError extends ScanError {
  readonly kind = "package-manager-undetected" as const;
}
