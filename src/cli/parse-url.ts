/**
 * Classifies the CLI's single positional `<url>` argument into a PR-link
 * shape (`github.com/owner/repo/pull/<n>`) or a plain-repo-link shape
 * (`github.com/owner/repo`), per `core-design.md`'s "System shape" — the
 * URL's own shape carries what to scan, with no separate `--pr` flag.
 * Kept independent of Commander so classification is testable as a plain
 * function, and so `program.ts` can surface a rejection through
 * `InvalidArgumentError` before any sandbox is provisioned (rule 4).
 */

export interface ParsedUrl {
  repoUrl: string;
  prNumber: number | undefined;
}

/** Thrown for a URL that is neither a recognizable PR link nor a
 *  recognizable plain repo link. Carries a human-readable `message` naming
 *  the problem — never a raw stack trace — for `program.ts` to surface via
 *  `InvalidArgumentError`. */
export class InvalidUrlError extends Error {
  constructor(rawUrl: string) {
    super(
      `"${rawUrl}" is not a recognizable GitHub repo or PR URL. Expected ` +
        `https://github.com/<owner>/<repo> or ` +
        `https://github.com/<owner>/<repo>/pull/<number>.`,
    );
    this.name = "InvalidUrlError";
  }
}

const OWNER_REPO = "[A-Za-z0-9._-]+";

// Tolerates with/without an `https://` scheme and with/without a trailing
// slash. Anchored end-to-end (no trailing path beyond what each pattern
// names) so a URL with extra segments after the recognized shape is
// rejected rather than silently truncated.
const PR_LINK_PATTERN = new RegExp(
  `^(?:https?://)?github\\.com/(${OWNER_REPO})/(${OWNER_REPO})/pull/(\\d+)/?$`,
  "i",
);
const REPO_LINK_PATTERN = new RegExp(
  `^(?:https?://)?github\\.com/(${OWNER_REPO})/(${OWNER_REPO}?)(?:\\.git)?/?$`,
  "i",
);

/**
 * Classifies a raw URL string into `{ repoUrl, prNumber }` — `prNumber` set
 * for a PR link, `undefined` for a plain repo link — or throws
 * `InvalidUrlError` for anything else. `repoUrl` is always normalized to a
 * plain `https://github.com/<owner>/<repo>` URL, even when parsed from a PR
 * link, since that's the shape `domain`'s clone step expects.
 */
export function parseUrl(rawUrl: string): ParsedUrl {
  const trimmed = rawUrl.trim();

  const prMatch = PR_LINK_PATTERN.exec(trimmed);
  if (prMatch) {
    const [, owner, repo, prNumberRaw] = prMatch;
    const prNumber = Number.parseInt(prNumberRaw!, 10);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
      throw new InvalidUrlError(rawUrl);
    }
    return { repoUrl: `https://github.com/${owner}/${repo}`, prNumber };
  }

  const repoMatch = REPO_LINK_PATTERN.exec(trimmed);
  if (repoMatch) {
    const [, owner, repo] = repoMatch;
    if (!owner || !repo) {
      throw new InvalidUrlError(rawUrl);
    }
    return { repoUrl: `https://github.com/${owner}/${repo}`, prNumber: undefined };
  }

  throw new InvalidUrlError(rawUrl);
}
