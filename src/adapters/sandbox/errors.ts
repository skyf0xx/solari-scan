/**
 * Maps `@solarisdk/sandbox`'s real error hierarchy onto domain's typed
 * errors. See the module-level comment on `mapSdkError` for the open
 * question this mapping can't fully resolve from the SDK's published types
 * alone.
 */

import { ConcurrencyLimitError, GatewayError, NoCapacityError, PlanError } from "@solarisdk/sandbox";
import {
  SandboxCapacityError,
  SandboxCreditExhaustionError,
  SandboxProvisioningError,
  type ScanError,
} from "../../domain/errors.js";

const CREDIT_FLAVOR_PATTERN = /credit|insufficient|billing|quota/i;

function isCreditFlavored(err: GatewayError): boolean {
  const code = err.body?.code ?? err.code;
  const candidates = [code, err.body?.error, err.body?.message, err.message];
  return candidates.some((value) => typeof value === "string" && CREDIT_FLAVOR_PATTERN.test(value));
}

/**
 * OPEN QUESTION (flagged, not settled): `@solarisdk/core` 0.1.2 has no
 * dedicated "credit exhausted" error class. `PlanError` (402
 * `FeatureRequiresPlan`) is the closest documented fit, so it's always
 * mapped to `SandboxCreditExhaustionError`. Beyond that, credit exhaustion
 * on this SDK version might just as plausibly surface as a generic
 * `GatewayError` (e.g. a plain 402/429 with no specialized subclass) whose
 * `.body.code`/`.body.error`/`.message` mentions credits/billing/quota — so
 * this function pattern-matches those substrings (case-insensitively) as a
 * defensive fallback. This has NOT been verified against a live Solari
 * account hitting real credit exhaustion; it's a best-effort guess from the
 * published type shape alone. If it guesses wrong, the error still reaches
 * the user as a `SandboxProvisioningError` with the SDK's original message
 * intact (never swallowed), so nothing is silently misreported — just
 * possibly mis-*categorized*.
 *
 * `ConcurrencyLimitError` (429) and `NoCapacityError` (503) both mean "no
 * room right now" from the CLI's perspective (one is account-level
 * concurrency, the other is host-level capacity) and both map to
 * `SandboxCapacityError`, per `core-design.md`'s error model.
 */
export function mapSdkError(err: unknown, fallbackMessage: string): ScanError {
  if (err instanceof ConcurrencyLimitError) {
    return new SandboxCapacityError(err.message, { cause: err });
  }
  if (err instanceof NoCapacityError) {
    return new SandboxCapacityError(err.message, { cause: err });
  }
  if (err instanceof PlanError) {
    return new SandboxCreditExhaustionError(err.message, { cause: err });
  }
  if (err instanceof GatewayError) {
    if (isCreditFlavored(err)) {
      return new SandboxCreditExhaustionError(err.message, { cause: err });
    }
    return new SandboxProvisioningError(err.message, { cause: err });
  }
  if (err instanceof Error) {
    return new SandboxProvisioningError(err.message, { cause: err });
  }
  return new SandboxProvisioningError(fallbackMessage, { cause: err });
}
