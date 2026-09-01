import { describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({
  config: vi.fn(),
}));

import { DEFAULT_BASE_URL, loadConfig, MissingApiKeyError } from "./config.js";

describe("loadConfig", () => {
  it("throws MissingApiKeyError when SOLARI_API_KEY is absent", () => {
    expect(() => loadConfig({})).toThrow(MissingApiKeyError);
  });

  it("MissingApiKeyError's message is clear and actionable, not a stack trace fragment", () => {
    try {
      loadConfig({});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MissingApiKeyError);
      expect((err as Error).message).toContain("SOLARI_API_KEY");
      expect((err as Error).message).toContain(".env");
    }
  });

  it("returns apiKey and the default baseUrl when only SOLARI_API_KEY is set", () => {
    const config = loadConfig({ SOLARI_API_KEY: "sk-test-123" });
    expect(config).toEqual({ apiKey: "sk-test-123", baseUrl: DEFAULT_BASE_URL });
  });

  it("prefers SOLARI_BASE_URL over the default when set", () => {
    const config = loadConfig({
      SOLARI_API_KEY: "sk-test-123",
      SOLARI_BASE_URL: "https://custom.example.test",
    });
    expect(config).toEqual({ apiKey: "sk-test-123", baseUrl: "https://custom.example.test" });
  });

  it("falls back to the default baseUrl when SOLARI_BASE_URL is an empty string", () => {
    const config = loadConfig({ SOLARI_API_KEY: "sk-test-123", SOLARI_BASE_URL: "" });
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
  });
});
