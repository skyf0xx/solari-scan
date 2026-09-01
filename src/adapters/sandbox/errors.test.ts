import { describe, expect, it, vi } from "vitest";
import {
  SandboxCapacityError,
  SandboxCreditExhaustionError,
  SandboxProvisioningError,
} from "../../domain/errors.js";

const { FakeGatewayError, FakeConcurrencyLimitError, FakeNoCapacityError, FakePlanError } = vi.hoisted(() => {
  class FakeGatewayError extends Error {
    readonly status: number;
    readonly code?: string;
    readonly body?: { code?: string; error?: string; message?: string; retryable?: boolean };

    constructor(status: number, message: string, body?: FakeGatewayError["body"]) {
      super(message);
      this.name = "GatewayError";
      this.status = status;
      this.code = body?.code;
      this.body = body;
    }
  }

  class FakeConcurrencyLimitError extends FakeGatewayError {
    constructor(message = "Too many live sandboxes") {
      super(429, message, { code: "ConcurrencyLimitExceeded" });
    }
  }

  class FakeNoCapacityError extends FakeGatewayError {
    constructor(message = "No desktop host available") {
      super(503, message);
    }
  }

  class FakePlanError extends FakeGatewayError {
    constructor(message = "Feature requires a paid plan") {
      super(402, message, { code: "FeatureRequiresPlan" });
    }
  }

  return { FakeGatewayError, FakeConcurrencyLimitError, FakeNoCapacityError, FakePlanError };
});

vi.mock("@solarisdk/sandbox", () => ({
  GatewayError: FakeGatewayError,
  ConcurrencyLimitError: FakeConcurrencyLimitError,
  NoCapacityError: FakeNoCapacityError,
  PlanError: FakePlanError,
}));

import { mapSdkError } from "./errors.js";

describe("mapSdkError", () => {
  it("maps ConcurrencyLimitError to SandboxCapacityError", () => {
    const mapped = mapSdkError(new FakeConcurrencyLimitError(), "fallback");
    expect(mapped).toBeInstanceOf(SandboxCapacityError);
  });

  it("maps NoCapacityError to SandboxCapacityError", () => {
    const mapped = mapSdkError(new FakeNoCapacityError(), "fallback");
    expect(mapped).toBeInstanceOf(SandboxCapacityError);
  });

  it("maps PlanError to SandboxCreditExhaustionError", () => {
    const mapped = mapSdkError(new FakePlanError(), "fallback");
    expect(mapped).toBeInstanceOf(SandboxCreditExhaustionError);
  });

  it("maps a plain GatewayError with a credit-flavored body.code to SandboxCreditExhaustionError", () => {
    const mapped = mapSdkError(
      new FakeGatewayError(402, "nope", { code: "InsufficientCredits" }),
      "fallback",
    );
    expect(mapped).toBeInstanceOf(SandboxCreditExhaustionError);
  });

  it("maps a plain GatewayError with a credit-flavored body.error to SandboxCreditExhaustionError", () => {
    const mapped = mapSdkError(
      new FakeGatewayError(402, "nope", { error: "billing_required" }),
      "fallback",
    );
    expect(mapped).toBeInstanceOf(SandboxCreditExhaustionError);
  });

  it("maps a plain GatewayError with no credit signal to SandboxProvisioningError", () => {
    const mapped = mapSdkError(new FakeGatewayError(500, "internal error"), "fallback");
    expect(mapped).toBeInstanceOf(SandboxProvisioningError);
    expect(mapped.message).toContain("internal error");
  });

  it("maps a generic Error to SandboxProvisioningError, preserving the message", () => {
    const mapped = mapSdkError(new Error("ECONNRESET"), "fallback");
    expect(mapped).toBeInstanceOf(SandboxProvisioningError);
    expect(mapped.message).toContain("ECONNRESET");
  });

  it("maps a non-Error thrown value to SandboxProvisioningError using the fallback message", () => {
    const mapped = mapSdkError("weird string throw", "fallback message");
    expect(mapped).toBeInstanceOf(SandboxProvisioningError);
    expect(mapped.message).toBe("fallback message");
  });
});
