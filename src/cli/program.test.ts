import { CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createProgram, type ParsedArgs } from "./program.js";

const ARGV_PREFIX = ["node", "solari-scan"];

describe("createProgram", () => {
  it("parses a repo URL positional and a numeric --pr option", async () => {
    const onRun = vi.fn();
    const program = createProgram({ onRun });

    await program.parseAsync([...ARGV_PREFIX, "https://github.com/acme/widgets", "--pr", "42"]);

    expect(onRun).toHaveBeenCalledWith({
      repoUrl: "https://github.com/acme/widgets",
      prNumber: 42,
    } satisfies ParsedArgs);
  });

  it("throws a CommanderError instead of calling process.exit when --pr is missing", async () => {
    const onRun = vi.fn();
    const program = createProgram({ onRun });

    await expect(
      program.parseAsync([...ARGV_PREFIX, "https://github.com/acme/widgets"]),
    ).rejects.toBeInstanceOf(CommanderError);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("throws a CommanderError when the repo URL positional is missing", async () => {
    const onRun = vi.fn();
    const program = createProgram({ onRun });

    await expect(program.parseAsync([...ARGV_PREFIX, "--pr", "42"])).rejects.toBeInstanceOf(
      CommanderError,
    );
    expect(onRun).not.toHaveBeenCalled();
  });

  it("throws a CommanderError when --pr is not a positive integer", async () => {
    const onRun = vi.fn();
    const program = createProgram({ onRun });

    await expect(
      program.parseAsync([...ARGV_PREFIX, "https://github.com/acme/widgets", "--pr", "not-a-number"]),
    ).rejects.toBeInstanceOf(CommanderError);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("throws a CommanderError when --pr is zero or negative", async () => {
    const onRun = vi.fn();
    const program = createProgram({ onRun });

    await expect(
      program.parseAsync([...ARGV_PREFIX, "https://github.com/acme/widgets", "--pr", "0"]),
    ).rejects.toBeInstanceOf(CommanderError);
    await expect(
      program.parseAsync([...ARGV_PREFIX, "https://github.com/acme/widgets", "--pr", "-1"]),
    ).rejects.toBeInstanceOf(CommanderError);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("throws a CommanderError when --pr has a decimal value", async () => {
    const onRun = vi.fn();
    const program = createProgram({ onRun });

    await expect(
      program.parseAsync([...ARGV_PREFIX, "https://github.com/acme/widgets", "--pr", "4.5"]),
    ).rejects.toBeInstanceOf(CommanderError);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("does not register any flag beyond --pr", () => {
    const program = createProgram({ onRun: vi.fn() });
    const optionFlags = program.options.map((opt) => opt.long);
    expect(optionFlags).toEqual(["--pr"]);
  });
});
