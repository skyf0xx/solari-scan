import { describe, expect, it } from "vitest";
import { detectPackageManager } from "./package-manager.js";

describe("detectPackageManager", () => {
  it("prefers pnpm-lock.yaml over package.json", () => {
    expect(detectPackageManager(["pnpm-lock.yaml", "package.json"])).toEqual({
      installCommand: "pnpm install",
      buildCommand: "pnpm run build",
    });
  });

  it("detects npm from package.json alone", () => {
    expect(detectPackageManager(["package.json", "README.md"])).toEqual({
      installCommand: "npm install",
      buildCommand: "npm run build",
    });
  });

  it("detects pip from requirements.txt", () => {
    expect(detectPackageManager(["requirements.txt"])).toEqual({
      installCommand: "pip install -r requirements.txt",
      buildCommand: "python -m build",
    });
  });

  it("returns undefined when no known marker file is present", () => {
    expect(detectPackageManager(["README.md", "LICENSE"])).toBeUndefined();
  });
});
