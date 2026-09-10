import { existsSync } from "node:fs";

export interface RemovalSafety {
  safe: boolean;
  reason?: string;
}

type RunGit = (cwd: string, args: string[]) => { code: number; stdout: string };
const runGit: RunGit = (cwd, args) => {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  return { code: p.exitCode, stdout: p.stdout.toString().trim() };
};

/**
 * Relay must decide that a worktree is disposable before asking Claude to remove it. Claude's
 * refusal remains a second guard, but CLI wording or behaviour is not the safety boundary.
 *
 * A clean worktree is safe when it never moved from the recorded base, or when its current HEAD
 * is reachable from a remote ref. Missing/ambiguous evidence is a refusal, never permission.
 */
export function removalSafety(
  worktreePath: string | null,
  baseSha: string | null,
  isGitProject: boolean,
  relayOwnerVerified = false,
  git: RunGit = runGit,
): RemovalSafety {
  if (!worktreePath || !existsSync(worktreePath) || !isGitProject) return { safe: true };

  const status = git(worktreePath, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status.code !== 0) return { safe: false, reason: "worktree state could not be verified" };
  // Relay's verified ownership stamp is metadata that removeSession unlinks immediately before native rm. Ignore
  // exactly its untracked root entry, never a tracked modification or any other untracked user file.
  const dirty = status.stdout.split("\n").filter((line) => line && !(relayOwnerVerified && line === "?? .relay-owner"));
  if (dirty.length) return { safe: false, reason: "worktree has uncommitted changes" };

  const head = git(worktreePath, ["rev-parse", "HEAD"]);
  if (head.code !== 0 || !head.stdout) return { safe: false, reason: "worktree HEAD could not be verified" };
  if (baseSha && head.stdout === baseSha) return { safe: true };

  const remote = git(worktreePath, ["for-each-ref", "--format=%(refname)", "--contains", head.stdout, "refs/remotes"]);
  if (remote.code !== 0) return { safe: false, reason: "remote containment could not be verified" };
  if (!remote.stdout) return { safe: false, reason: "worktree has commits that are not pushed anywhere" };
  return { safe: true };
}
