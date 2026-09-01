import { CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createProgram, type ParsedArgs } from "./program.js";

const ARGV_PREFIX = ["node", "solari-scan"];

describe("createProgram", () => {
  it("parses a plain repo URL into repoUrl with no prNumber", async () => {
    const onRun = vi.fn();
    const program = createProgram({ onRun });

    await program.parseAsync([...ARGV_PREFIX, "https://github.com/acme/widgets"]);

    expect(onRun).toHaveBeenCalledWith({
      repoUrl: "https://github.com/acme/widgets",
    } satisfies ParsedArgs);
  });

  it("parses a PR URL into repoUrl + prNumber", async () => {
    const onRun = vi.fn();
    const program = createProgram({ onRun });

    await program.parseAsync([...ARGV_PREFIX, "https://github.com/acme/widgets/pull/42"]);

    expect(onRun).toHaveBeenCalledWith({
      repoUrl: "https://github.com/acme/widgets",
      prNumber: 42,
    } satisfies ParsedArgs);
  });

  it("tolerates a PR URL without a scheme and with a trailing slash", async () => {
    const onRun = vi.fn();
    const program = createProgram({ onRun });

    await program.parseAsync([...ARGV_PREFIX, "github.com/acme/widgets/pull/7/"]);

    expect(onRun).toHaveBeenCalledWith({
      repoUrl: "https://github.com/acme/widgets",
      prNumber: 7,
    } satisfies ParsedArgs);
  });

  it("tolerates a plain repo URL without a scheme and with a trailing slash", async () => {
    const onRun = vi.fn();
    const program = createProgram({ onRun });

    await program.parseAsync([...ARGV_PREFIX, "github.com/acme/widgets/"]);

    expect(onRun).toHaveBeenCalledWith({
      repoUrl: "https://github.com/acme/widgets",
    } satisfies ParsedArgs);
  });

  it("throws a CommanderError when the url positional is missing", async () => {
    const onRun = vi.fn();
    const program = createProgram({ onRun });

    await expect(program.parseAsync([...ARGV_PREFIX])).rejects.toBeInstanceOf(CommanderError);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("throws a CommanderError for a URL that is neither a PR link nor a plain repo link, before onRun is invoked", async () => {
    const onRun = vi.fn();
    const program = createProgram({ onRun });

    await expect(
      program.parseAsync([...ARGV_PREFIX, "https://example.com/not/github"]),
    ).rejects.toBeInstanceOf(CommanderError);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("throws a CommanderError with an actionable message (not a raw stack trace) for a malformed URL", async () => {
    const onRun = vi.fn();
    const program = createProgram({ onRun });

    try {
      await program.parseAsync([...ARGV_PREFIX, "not-a-url-at-all"]);
      expect.fail("expected parseAsync to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(CommanderError);
      const message = (err as CommanderError).message;
      expect(message).toContain("not-a-url-at-all");
      expect(message).not.toContain(" at ");
    }
    expect(onRun).not.toHaveBeenCalled();
  });

  it("rejects --pr as an unrecognized option", async () => {
    const onRun = vi.fn();
    const program = createProgram({ onRun });

    await expect(
      program.parseAsync([...ARGV_PREFIX, "--pr", "42", "https://github.com/acme/widgets"]),
    ).rejects.toBeInstanceOf(CommanderError);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("registers no flags at all", () => {
    const program = createProgram({ onRun: vi.fn() });
    expect(program.options).toHaveLength(0);
  });
});
