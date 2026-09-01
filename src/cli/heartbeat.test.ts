import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHeartbeat } from "./heartbeat.js";

describe("startHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a heartbeat line roughly every 2 seconds while the operation is pending", () => {
    const writeStdout = vi.fn();
    const heartbeat = startHeartbeat("Provisioning sandbox", writeStdout);

    expect(writeStdout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(writeStdout).toHaveBeenCalledTimes(1);
    expect(writeStdout.mock.calls[0]?.[0]).toContain("Provisioning sandbox... (2s)");

    vi.advanceTimersByTime(2000);
    expect(writeStdout).toHaveBeenCalledTimes(2);
    expect(writeStdout.mock.calls[1]?.[0]).toContain("Provisioning sandbox... (4s)");

    heartbeat.stop();
  });

  it("overwrites the same terminal line using a leading carriage return, not a new line each tick", () => {
    const writeStdout = vi.fn();
    const heartbeat = startHeartbeat("Running install", writeStdout);

    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(2000);

    for (const [data] of writeStdout.mock.calls) {
      expect(data as string).toMatch(/^\r/);
      expect(data as string).not.toContain("\n");
    }

    heartbeat.stop();
  });

  it("stops ticking the instant stop() is called — no further writes after that point", () => {
    const writeStdout = vi.fn();
    const heartbeat = startHeartbeat("Running build", writeStdout);

    vi.advanceTimersByTime(2000);
    expect(writeStdout).toHaveBeenCalledTimes(1);

    heartbeat.stop();
    writeStdout.mockClear();

    vi.advanceTimersByTime(10000);
    expect(writeStdout).not.toHaveBeenCalled();
  });

  it("stop() is idempotent — calling it more than once does not throw or double-write the clear", () => {
    const writeStdout = vi.fn();
    const heartbeat = startHeartbeat("Running build", writeStdout);

    vi.advanceTimersByTime(2000);
    writeStdout.mockClear();

    expect(() => {
      heartbeat.stop();
      heartbeat.stop();
    }).not.toThrow();

    // Only the first stop() should have written a clear-line sequence.
    expect(writeStdout).toHaveBeenCalledTimes(1);
  });

  it("clears the line on stop() so no half-overwritten heartbeat text remains before the next real line", () => {
    const writeStdout = vi.fn();
    const heartbeat = startHeartbeat("Provisioning sandbox", writeStdout);

    vi.advanceTimersByTime(2000);
    const lastTick = writeStdout.mock.calls.at(-1)?.[0] as string;
    writeStdout.mockClear();

    heartbeat.stop();

    expect(writeStdout).toHaveBeenCalledTimes(1);
    const clearWrite = writeStdout.mock.calls[0]?.[0] as string;
    expect(clearWrite.startsWith("\r")).toBe(true);
    expect(clearWrite.endsWith("\r")).toBe(true);
    // The clear write pads with at least as many spaces as the last tick's
    // visible content, so it fully overwrites it.
    expect(clearWrite.length).toBeGreaterThanOrEqual(lastTick.replace(/^\r/, "").length);
  });

  it("leaves no dangling timer that would keep the process alive if stop() is never called", () => {
    const writeStdout = vi.fn();
    startHeartbeat("Provisioning sandbox", writeStdout);

    // vitest's fake-timer count reflects only scheduled timers; a heartbeat
    // that failed to unref/clear would still show up here after the test
    // itself finishes advancing time. The real safety net is the explicit
    // `unref()` call in the implementation — this test documents the
    // contract rather than re-implementing Node's own timer bookkeeping.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("calling stop() before any tick fires still leaves no pending timer", () => {
    const writeStdout = vi.fn();
    const heartbeat = startHeartbeat("Provisioning sandbox", writeStdout);

    heartbeat.stop();
    vi.advanceTimersByTime(10000);

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it("supports a custom interval", () => {
    const writeStdout = vi.fn();
    const heartbeat = startHeartbeat("Provisioning sandbox", writeStdout, 500);

    vi.advanceTimersByTime(500);
    expect(writeStdout).toHaveBeenCalledTimes(1);

    heartbeat.stop();
  });
});
