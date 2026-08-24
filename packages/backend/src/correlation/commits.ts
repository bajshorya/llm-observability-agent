/**
 * Parsing `git log` into candidate commits — PURE.
 *
 * WHAT THIS FILE DOES
 * Turns the raw stdout of one `git log` invocation into validated
 * `CandidateCommit`s. It runs no subprocess, reads no clock and touches no
 * database: text in, commits out. `git.ts` owns the impure half.
 *
 * That split is the same one `detectors.ts` / `engine.ts` uses, and it buys the
 * same thing — these tests need no repository, no fixture and no filesystem,
 * just a string. The awkward cases below (a body containing the separator, a
 * binary file, an empty commit) are exactly the ones that are painful to
 * produce on demand in a real repo and trivial to write down here.
 *
 * THE FORMAT, AND WHY IT LOOKS LIKE THAT
 * Commit bodies contain newlines, blank lines, colons, and anything else a
 * developer typed. Any parser keyed on human-readable punctuation is one
 * unusual commit message away from being wrong, and wrong here means a
 * mis-attributed cause.
 *
 * So the format uses two ASCII control characters that cannot appear in git
 * metadata:
 *
 *     \x1e  RECORD SEPARATOR   brackets each commit header
 *     \x1f  UNIT SEPARATOR     between fields inside a header
 *
 * `GIT_LOG_FORMAT` opens AND closes each header with \x1e, so splitting the
 * whole stdout on \x1e yields strictly alternating chunks:
 *
 *     ["", header, numstat, header, numstat, ...]
 *
 * The body is the last field inside the header, where its newlines are
 * harmless — they are inside a bracketed region, not delimiting it. The
 * numstat lines then sit in the chunk that follows, outside the brackets.
 *
 * TWO SEPARATORS, TWO DIFFERENT DEFENCES
 * The body is the LAST field, so it is split off by position, not by counting:
 * everything after the fourth \x1f is body, however many \x1f it contains.
 * A body carrying a unit separator therefore parses correctly. This is not
 * hypothetical tidiness — the first version of this parser split on \x1f and
 * counted fields, and a test with \x1f in the body failed it.
 *
 * \x1e is the residual, and it is NOT fully defensible in this format: a
 * record separator inside a body destroys the bracketing, and the body's tail
 * becomes indistinguishable from the numstat block that follows it. Closing
 * that would need git to frame the records itself. What this parser does
 * instead is DETECT it, with two guards that between them leave no quiet path
 * through: a header chunk must open with 40 hex characters and a separator,
 * and a numstat chunk must contain only `added\tdeleted\tpath` lines. A stray
 * \x1e trips one or the other depending on where it lands. The pathological
 * commit message therefore produces a loud failure rather than a commit
 * silently attributed to the wrong sha, which is the only outcome that would
 * actually matter.
 *
 * WHAT IT EXPORTS
 *   - `GIT_LOG_FORMAT`   the --format string. `git.ts` must pass exactly this.
 *   - `GIT_LOG_ARGS`     the full argument list, so the two cannot drift.
 *   - `parseGitLog`      stdout -> CandidateCommit[], newest first
 *
 * ON FAILURE
 * A record that does not have the expected field count throws. It does not
 * skip the record and carry on: a parser that silently drops commits produces
 * a correlation over a history with holes in it, and the answer looks exactly
 * as confident as a correct one. Loud is better.
 */

import { candidateCommitSchema, type CandidateCommit, type ChangedFile } from "@obs/shared";

const RECORD = "\x1e";
const UNIT = "\x1f";

/** Every header opens with the full sha and a separator. See the header. */
const HEADER_START = /^[0-9a-f]{40}\x1f/;

/**
 * Field order: sha, author date (strict ISO), author name, subject, body.
 * Body is last so its newlines fall inside the bracketed header.
 *
 * `%x1e` and `%x1f` emit the raw separator bytes.
 */
export const GIT_LOG_FORMAT = `%x1e%H%x1f%aI%x1f%an%x1f%s%x1f%b%x1e`;

/**
 * The complete argument list, exported so the format and the flags that depend
 * on it stay together.
 *
 * `--numstat` gives per-file line counts, which is the difference between "this
 * commit touched pricing" and "this commit rewrote pricing". `--no-renames`
 * keeps a rename reported as its real path rather than a `{old => new}`
 * expression the parser would have to understand. `--no-merges` drops merge
 * commits: they introduce no changes of their own, and offering them as
 * candidates is offering the model a cause that cannot be one.
 */
export const GIT_LOG_ARGS = [
  "log",
  "--numstat",
  "--no-renames",
  "--no-merges",
  `--format=${GIT_LOG_FORMAT}`,
] as const;

/**
 * `git log --numstat` prints a line count, or `-` for a binary file.
 * Null rather than zero: zero is a measurement, `-` is the absence of one.
 */
function parseCount(raw: string): number | null {
  if (raw === "-") return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`git log: unparseable numstat count ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * The chunk after a header: zero or more `added\tdeleted\tpath` lines.
 *
 * Zero is normal, not an error — an empty commit, or `--no-renames` on a pure
 * rename, both produce a header with nothing after it.
 */
function parseNumstat(chunk: string): ChangedFile[] {
  const files: ChangedFile[] = [];

  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    // Split on the first two tabs only: a path may legally contain a tab.
    const firstTab = trimmed.indexOf("\t");
    const secondTab = trimmed.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      throw new Error(`git log: unparseable numstat line ${JSON.stringify(line)}`);
    }

    files.push({
      added: parseCount(trimmed.slice(0, firstTab)),
      deleted: parseCount(trimmed.slice(firstTab + 1, secondTab)),
      path: trimmed.slice(secondTab + 1),
    });
  }

  return files;
}

/**
 * Parse one `git log` run into commits, newest first (git's own order).
 *
 * Empty stdout is an empty array, not an error. A repository with no commits
 * in the lookback window is a legitimate and informative answer: it means no
 * commit can explain the anomaly, and the correlation agent should say so.
 */
export function parseGitLog(stdout: string): CandidateCommit[] {
  const chunks = stdout.split(RECORD);
  const commits: CandidateCommit[] = [];

  // chunks[0] is whatever preceded the first record — always empty in
  // practice, and ignored rather than asserted so a trailing newline from a
  // shell pipeline cannot fail the parse.
  for (let i = 1; i < chunks.length; i += 2) {
    const header = chunks[i] ?? "";

    // A header always opens with the full sha and a separator. Anything else
    // in a header position means the record framing was broken upstream — a
    // \x1e inside a commit body is the way that happens. Fail here rather
    // than parse a numstat block as though it were a commit.
    if (!HEADER_START.test(header)) {
      throw new Error(
        `git log: record ${(i + 1) / 2} does not begin with a sha — ` +
          `a commit message probably contains a record separator`,
      );
    }

    // The first four separators delimit the fixed fields; everything after the
    // fourth is body, whatever it contains. Splitting and counting would
    // reject any body carrying a unit separator.
    const bounds: number[] = [];
    let at = -1;
    for (let f = 0; f < 4; f += 1) {
      at = header.indexOf(UNIT, at + 1);
      if (at === -1) {
        throw new Error(
          `git log: expected 5 fields in record ${(i + 1) / 2}, got ${bounds.length + 1}`,
        );
      }
      bounds.push(at);
    }

    const [shaEnd, dateEnd, authorEnd, subjectEnd] = bounds as [number, number, number, number];
    const sha = header.slice(0, shaEnd);
    const isoDate = header.slice(shaEnd + 1, dateEnd);
    const author = header.slice(dateEnd + 1, authorEnd);
    const subject = header.slice(authorEnd + 1, subjectEnd);
    const body = header.slice(subjectEnd + 1);

    const committedAt = new Date(isoDate);
    if (Number.isNaN(committedAt.getTime())) {
      throw new Error(`git log: unparseable date ${JSON.stringify(isoDate)} on ${sha}`);
    }

    commits.push(
      candidateCommitSchema.parse({
        sha,
        committedAt,
        author,
        subject,
        // `%b` ends with a trailing newline whenever a body exists.
        body: body.trim(),
        files: parseNumstat(chunks[i + 1] ?? ""),
      }),
    );
  }

  return commits;
}
