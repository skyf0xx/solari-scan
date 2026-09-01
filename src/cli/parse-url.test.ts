import { describe, expect, it } from "vitest";
import { InvalidUrlError, parseUrl } from "./parse-url.js";

describe("parseUrl", () => {
  describe("PR link shape", () => {
    it("parses a full https PR URL", () => {
      expect(parseUrl("https://github.com/acme/widgets/pull/123")).toEqual({
        repoUrl: "https://github.com/acme/widgets",
        prNumber: 123,
      });
    });

    it("tolerates a missing scheme", () => {
      expect(parseUrl("github.com/acme/widgets/pull/123")).toEqual({
        repoUrl: "https://github.com/acme/widgets",
        prNumber: 123,
      });
    });

    it("tolerates a trailing slash", () => {
      expect(parseUrl("https://github.com/acme/widgets/pull/123/")).toEqual({
        repoUrl: "https://github.com/acme/widgets",
        prNumber: 123,
      });
    });

    it("tolerates http (not just https)", () => {
      expect(parseUrl("http://github.com/acme/widgets/pull/1")).toEqual({
        repoUrl: "https://github.com/acme/widgets",
        prNumber: 1,
      });
    });

    it("normalizes repoUrl to the plain repo, not the PR path", () => {
      const { repoUrl } = parseUrl("https://github.com/acme/widgets/pull/999");
      expect(repoUrl).not.toContain("pull");
    });

    it("rejects a PR number of zero", () => {
      expect(() => parseUrl("https://github.com/acme/widgets/pull/0")).toThrow(InvalidUrlError);
    });

    it("rejects a non-numeric PR segment", () => {
      expect(() => parseUrl("https://github.com/acme/widgets/pull/abc")).toThrow(InvalidUrlError);
    });

    it("rejects trailing path segments after the PR number", () => {
      expect(() => parseUrl("https://github.com/acme/widgets/pull/123/files")).toThrow(
        InvalidUrlError,
      );
    });
  });

  describe("plain repo link shape", () => {
    it("parses a full https repo URL with no prNumber", () => {
      expect(parseUrl("https://github.com/acme/widgets")).toEqual({
        repoUrl: "https://github.com/acme/widgets",
        prNumber: undefined,
      });
    });

    it("tolerates a missing scheme", () => {
      expect(parseUrl("github.com/acme/widgets")).toEqual({
        repoUrl: "https://github.com/acme/widgets",
        prNumber: undefined,
      });
    });

    it("tolerates a trailing slash", () => {
      expect(parseUrl("https://github.com/acme/widgets/")).toEqual({
        repoUrl: "https://github.com/acme/widgets",
        prNumber: undefined,
      });
    });

    it("tolerates a .git suffix", () => {
      expect(parseUrl("https://github.com/acme/widgets.git")).toEqual({
        repoUrl: "https://github.com/acme/widgets",
        prNumber: undefined,
      });
    });
  });

  describe("invalid shapes", () => {
    it("rejects a non-GitHub host", () => {
      expect(() => parseUrl("https://gitlab.com/acme/widgets")).toThrow(InvalidUrlError);
    });

    it("rejects a URL with no path at all", () => {
      expect(() => parseUrl("https://github.com")).toThrow(InvalidUrlError);
    });

    it("rejects a URL with only an owner and no repo", () => {
      expect(() => parseUrl("https://github.com/acme")).toThrow(InvalidUrlError);
    });

    it("rejects garbage input", () => {
      expect(() => parseUrl("not a url")).toThrow(InvalidUrlError);
    });

    it("rejects an empty string", () => {
      expect(() => parseUrl("")).toThrow(InvalidUrlError);
    });

    it("produces a message naming the offending input, not a raw stack trace", () => {
      try {
        parseUrl("https://example.com/nope");
        expect.fail("expected parseUrl to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidUrlError);
        const message = (err as InvalidUrlError).message;
        expect(message).toContain("https://example.com/nope");
        expect(message).not.toContain(" at ");
      }
    });
  });
});
