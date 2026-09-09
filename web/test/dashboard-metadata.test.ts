import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("dashboard declares English as its default document language", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  expect(html).toMatch(/<html\s+lang="en">/);
  expect(html).not.toMatch(/<html\s+lang="ko">/);
});
