import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const fixtureDir = join(import.meta.dir, "../../fixtures");
const forbidden = [/\/Users\//i, /dev-soon/i, /relay-wt-\d/i, /relay-spike/i, /\.claude\/projects/i];

test("versioned fixtures are synthetic baselines without local-capture identifiers", () => {
  const files = readdirSync(fixtureDir).filter((name) => name.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const text = readFileSync(join(fixtureDir, name), "utf8");
    for (const pattern of forbidden) expect(text).not.toMatch(pattern);
  }
});

test("fixture provenance policy records the review gate for future captures", () => {
  const policy = readFileSync(join(fixtureDir, "README.md"), "utf8");
  expect(policy).toContain("synthetic baseline");
  expect(policy).toContain("explicit public-use approval");
});
