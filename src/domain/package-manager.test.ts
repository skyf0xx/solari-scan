import { describe, expect, it } from "vitest";
import { detectPackageManager } from "./package-manager.js";

describe("detectPackageManager", () => {
  it("prefers package-lock.json over package.json", () => {
    expect(detectPackageManager(["package-lock.json", "package.json"])).toEqual({
      installCommand: "npm ci",
      buildCommand: "npm run build",
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
      buildCommand: "python3 -m build",
    });
  });

  it("returns undefined when no known marker file is present", () => {
    expect(detectPackageManager(["README.md", "LICENSE"])).toBeUndefined();
  });
});
