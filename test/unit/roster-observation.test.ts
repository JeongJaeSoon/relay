import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const [name, output, status, ok] of [
  ["successful empty roster", "[]", 0, true],
  ["CLI failure even with JSON", "[]", 1, false],
  ["invalid JSON", "incomplete", 0, false],
  ["wrong schema", "{}", 0, false],
  ["invalid rows", "[null]", 0, false],
] as const) {
  test(`operational roster observation: ${name}`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), "relay-roster-"));
    try {
      const command = join(scratch, "claude");
      writeFileSync(command, `#!/bin/sh\nprintf '%s' '${output}'\nexit ${status}\n`); chmodSync(command, 0o755);
      const target = join(scratch, "roster.json"); writeFileSync(target, "prior observation");
      const helper = join(import.meta.dir, "../support/read-roster.sh");
      const child = Bun.spawn(["bash", "-c", 'source "$1"; read_roster "$2"', "roster-test", helper, target], {
        env: { PATH: `${scratch}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe",
      });
      expect((await child.exited) === 0).toBe(ok);
      expect(readFileSync(target, "utf8")).toBe(ok ? "[]" : "prior observation");
      expect(readdirSync(scratch).filter(n => n.startsWith("roster.json.") && n !== "roster.json.error")).toEqual([]);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}
