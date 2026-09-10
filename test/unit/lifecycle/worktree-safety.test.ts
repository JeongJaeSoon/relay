import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removalSafety } from "../../../src/lifecycle/worktree-safety.ts";

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "relay-removal-"));
  git(dir, "init", "-q"); git(dir, "config", "user.name", "Relay Test"); git(dir, "config", "user.email", "relay@example.invalid");
  writeFileSync(join(dir, "tracked.txt"), "base\n"); git(dir, "add", "tracked.txt"); git(dir, "commit", "-qm", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

test("removal preflight permits an unchanged clean worktree", () => {
  const { dir, base } = repo();
  expect(removalSafety(dir, base, true)).toEqual({ safe: true });
});

test("the untracked Relay owner stamp alone does not make a clean worktree undeletable", () => {
  const { dir, base } = repo(); writeFileSync(join(dir, ".relay-owner"), "{}\n");
  expect(removalSafety(dir, base, true)).toEqual({ safe: false, reason: "worktree has uncommitted changes" });
  expect(removalSafety(dir, base, true, true)).toEqual({ safe: true });
  writeFileSync(join(dir, "user-file.txt"), "keep\n");
  expect(removalSafety(dir, base, true)).toEqual({ safe: false, reason: "worktree has uncommitted changes" });
});

test("removal preflight refuses dirty work before invoking the native remover", () => {
  const { dir, base } = repo(); writeFileSync(join(dir, "tracked.txt"), "dirty\n");
  expect(removalSafety(dir, base, true)).toEqual({ safe: false, reason: "worktree has uncommitted changes" });
});

test("removal preflight refuses a clean commit that is not on a remote ref", () => {
  const { dir, base } = repo(); writeFileSync(join(dir, "tracked.txt"), "next\n"); git(dir, "add", "tracked.txt"); git(dir, "commit", "-qm", "next");
  expect(removalSafety(dir, base, true)).toEqual({ safe: false, reason: "worktree has commits that are not pushed anywhere" });
});

test("missing worktrees and non-git project directories do not block session deregistration", () => {
  expect(removalSafety("/path/that/does/not/exist", null, true)).toEqual({ safe: true });
  const dir = mkdtempSync(join(tmpdir(), "relay-nongit-"));
  expect(removalSafety(dir, null, false)).toEqual({ safe: true });
});
