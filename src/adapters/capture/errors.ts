/**
 * Capture-adapter's own error type. `domain`'s `ScanError` hierarchy
 * (`src/domain/errors.ts`) has no filesystem- or proxy-capture error kind —
 * `runScan` (`src/domain/scan.ts`) does not wrap `CapturePort` calls in a
 * try/catch the way it does `SandboxPort`'s, so nothing downstream expects
 * a specific typed error from this layer. Rather than inventing a domain
 * error kind RELEVANT RULES doesn't name, capture failures throw this
 * adapter-local error with the original cause preserved — `command`'s
 * top-level handler (an `Error`, same as any other unexpected failure)
 * still catches and reports it, never a raw silent failure.
 */
export class CaptureAdapterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CaptureAdapterError";
  }
}
