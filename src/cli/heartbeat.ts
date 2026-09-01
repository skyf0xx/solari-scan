/**
 * A client-side "still working" ticker for the stretches of a scan that have
 * no intermediate fact to narrate — sandbox provisioning, and the gap
 * between announcing install/build and that command's first output chunk.
 * There is no SDK-side progress signal for any of these (confirmed by the
 * `sandbox-adapter`/`capture-adapter` layers), so this is a plain wall-clock
 * timer, not a read of any real step state — it only proves the process is
 * still alive, never a specific fact.
 *
 * Uses `writeStdout` (the raw chunk writer, not `stdout`'s one-line-per-call
 * form) and `\r` to overwrite the same line in place, rather than printing a
 * fresh narrated line every tick: a heartbeat can fire many times during a
 * slow install, and a new line per tick would flood the terminal in a way
 * the rest of this CLI's narration (one line per real fact) doesn't.
 */

import { renderHeartbeatLine } from "../report/index.js";

const DEFAULT_INTERVAL_MS = 2000;

export interface Heartbeat {
  /** Stops the ticker. Idempotent — safe to call more than once (e.g. once
   *  from the operation's own completion and once from an outer cleanup
   *  path) without double-clearing the interval or emitting a second
   *  clear-line write. */
  stop(): void;
}

/**
 * Starts a timer that calls `writeStdout` with `renderHeartbeatLine(label,
 * elapsedSeconds)` roughly every `intervalMs`, overwriting the same terminal
 * line via a leading `\r`. Returns a `Heartbeat` whose `stop()` clears the
 * interval and, if any heartbeat line was ever printed, clears it (writes
 * spaces over it and returns the cursor to column 0) so the next real
 * narration line prints cleanly rather than after a half-overwritten
 * heartbeat line.
 *
 * Callers are responsible for calling `stop()` the moment the wrapped
 * operation settles (resolves or rejects) — an uncleared `setInterval`
 * would keep the Node process alive even after the scan is otherwise done.
 */
export function startHeartbeat(
  label: string,
  writeStdout: (data: string) => void,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Heartbeat {
  const startedAt = Date.now();
  let lastLineLength = 0;
  let stopped = false;

  const tick = (): void => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const line = renderHeartbeatLine(label, elapsedSeconds);
    // Pad with trailing spaces to the previous line's length so a shorter
    // new line can't leave stray characters from the old one on the
    // terminal (elapsedSeconds only grows here, but this keeps the
    // invariant correct regardless of what `label` does).
    const padded = line.length >= lastLineLength ? line : line + " ".repeat(lastLineLength - line.length);
    writeStdout(`\r${padded}`);
    lastLineLength = line.length;
  };

  const interval = setInterval(tick, intervalMs);
  // Node's timers keep the event loop alive unless unref'd; `stop()` always
  // clears this explicitly on the happy path, but unref as a second,
  // independent safety net against a dangling timer if `stop()` is ever
  // missed on some future error path.
  interval.unref?.();

  return {
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(interval);
      if (lastLineLength > 0) {
        writeStdout(`\r${" ".repeat(lastLineLength)}\r`);
      }
    },
  };
}
