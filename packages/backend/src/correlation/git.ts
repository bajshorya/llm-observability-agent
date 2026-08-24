/**
 * Running `git log` against the target repository — IMPURE.
 *
 * WHAT THIS FILE DOES
 * The half of commit collection that touches the outside world: it spawns
 * `git`, resolves the repository path, and bounds the lookback. Parsing lives
 * in `commits.ts` and is pure. This file is the only one in `correlation/`
 * that can fail because of something outside the process.
 *
 * WHY THE LOOKBACK IS BOUNDED, AND WHY THAT BOUND IS A TRADE
 * The correlation agent is asked to name the commit that caused an anomaly, or
 * to name none. Both failure modes are real:
 *
 *   too narrow   the guilty commit is outside the window, so the only
 *                available answers are wrong ones or null — and a null here
 *                is right for the wrong reason, which is worse than useless
 *                because it looks like the system working.
 *   too wide     forty commits of noise, most of them irrelevant, and the
 *                model's job becomes a needle hunt. Input tokens grow
 *                linearly and precision falls.
 *
 * `defaultLookback` is 48 hours and 25 commits, whichever binds first. That is
 * wide enough to cover a bug that shipped Friday and surfaced under Monday
 * load, and narrow enough that a typical result is a page of text. Both are
 * arguments, not measurements — six golden cases cannot tune them, and tuning
 * them against six cases would mean nothing. They are stated here so the next
 * person can disagree with a number rather than discover one.
 *
 * WHY `until` IS THE END OF THE ANOMALY WINDOW
 * A commit made after the anomaly ended cannot have caused it. Passing
 * `--until` rather than filtering afterwards means those commits are never
 * fetched, never rendered and never offered — the model is not given the
 * chance to pick a cause that postdates its effect.
 *
 * WHY execFile AND NOT exec
 * `execFile` takes an argument array and never invokes a shell, so a branch or
 * path containing a quote or a semicolon is data rather than syntax. There is
 * no interpolation anywhere in this file for a shell to interpret.
 *
 * WHAT IT EXPORTS
 *   - `defaultLookback`     the bounds, with their reasoning above
 *   - `resolveTargetRepo`   TARGET_REPO_PATH -> absolute path, verified
 *   - `collectCommits`      the anomaly window -> a validated CommitWindow
 */

import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { commitWindowSchema, type CommitWindow } from "@obs/shared";
import { REPO_ROOT, env } from "../env";
import { GIT_LOG_ARGS, parseGitLog } from "./commits";

const run = promisify(execFile);

/**
 * How far back to look for candidate commits. See the header for why these
 * numbers are what they are, and why they are arguments rather than findings.
 */
export const defaultLookback = {
  hours: 48,
  /** Whichever bound binds first. A busy repo hits this one. */
  maxCommits: 25,
} as const;

/** Enough for a large history; a guard against an unbounded read, not a limit
 *  anyone should hit, since --max-count binds long before this does. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/**
 * Resolve `TARGET_REPO_PATH` and confirm it is really a git repository.
 *
 * Checked up front, with a message naming the script that builds the fixture,
 * because the alternative is `git log` failing inside a pipeline run and the
 * user reading "not a git repository" with no indication of which path was
 * tried or what was supposed to be there.
 */
export async function resolveTargetRepo(path = env.TARGET_REPO_PATH): Promise<string> {
  // Relative paths resolve from the repo root, not cwd — same rule as
  // DATABASE_URL, so a command behaves identically from any directory.
  const absolute = isAbsolute(path) ? path : resolve(REPO_ROOT, path);

  try {
    const { stdout } = await run("git", ["-C", absolute, "rev-parse", "--git-dir"], {
      maxBuffer: MAX_STDOUT_BYTES,
    });
    if (stdout.trim() === "") throw new Error("empty rev-parse output");
  } catch {
    throw new Error(
      `TARGET_REPO_PATH is not a git repository: ${absolute}\n` +
        `Build the fixture with:  bash scripts/build-fixture-repo.sh\n` +
        `Or point TARGET_REPO_PATH at a real checkout.`,
    );
  }

  return absolute;
}

export interface CollectCommitsOptions {
  /** End of the anomaly window. Commits after this cannot have caused it. */
  until: Date;
  lookbackHours?: number;
  maxCommits?: number;
  /** Defaults to `TARGET_REPO_PATH`. */
  repoPath?: string;
}

/**
 * Collect the commits that could plausibly explain an anomaly ending at
 * `until`, newest first.
 *
 * An empty result is a legitimate outcome, not a failure: it means no commit
 * landed in the lookback, and the honest correlation is `null`. That case is
 * distinguishable from "we never looked" only because `since` and `until` are
 * returned alongside the commits.
 */
export async function collectCommits(options: CollectCommitsOptions): Promise<CommitWindow> {
  const lookbackHours = options.lookbackHours ?? defaultLookback.hours;
  const maxCommits = options.maxCommits ?? defaultLookback.maxCommits;

  const until = options.until;
  const since = new Date(until.getTime() - lookbackHours * 60 * 60 * 1000);

  const repo = await resolveTargetRepo(options.repoPath);

  const { stdout } = await run(
    "git",
    [
      "-C",
      repo,
      ...GIT_LOG_ARGS,
      `--since=${since.toISOString()}`,
      `--until=${until.toISOString()}`,
      `--max-count=${maxCommits}`,
    ],
    { maxBuffer: MAX_STDOUT_BYTES },
  );

  // Validated rather than returned raw: the parser is pure and tested, but the
  // input it just parsed came from a subprocess, and this is the boundary.
  return commitWindowSchema.parse({
    commits: parseGitLog(stdout),
    since,
    until,
  } satisfies CommitWindow);
}
