import { expect, test } from "bun:test";
import { redact, capPayload } from "../../../src/core/redact.ts";
test("redacts known secret shapes", () => {
  const s = "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij Authorization: Bearer abcdefghijklmnopqrstuvwxyz";
  const r = redact(s);
  expect(r).not.toContain("sk-ant-api03"); expect(r).not.toContain("ghp_A"); expect(r).toContain("[redacted:anthropic]"); expect(r).toContain("[redacted:github]"); expect(r).toContain("[redacted:bearer]");
});
test("caps payload at 64KB and marks truncation", () => {
  const big = { text: "x".repeat(70_000) };
  const { json, truncated } = capPayload(big);
  expect(truncated).toBe(true); expect(json.length).toBeLessThanOrEqual(65_536 + 200); expect(JSON.parse(json).__truncated).toBe(true);
});
