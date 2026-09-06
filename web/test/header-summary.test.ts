import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const code = app.slice(app.indexOf("function renderHeaderSummary(){"), app.indexOf("function renderSidebar(){"));

test("header activity updates preserve expanded details and expose quota, pause and estimated usage", () => {
  const summary: any = { textContent: "", children: [], append(...items: any[]) { this.children = items; }, setAttribute(key: string, value: string) { this[key] = value; } };
  const panel: any = {};
  const flags: any = {};
  const host = { open: true, classList: { toggle(key: string, value: boolean) { flags[key] = value; } }, querySelector(sel: string) { return sel === "summary" ? summary : panel; } };
  const S: any = { maxw: 24, usage: 91000, dailyCeiling: 100000, paused: true };
  const ctx: any = { $: () => host, S, runningCount: () => 15, tasksArr: () => [{ status: "queue" }, { status: "run" }], el: (_tag: string, cls: string, text: string) => ({ cls, text }) };
  runInNewContext(code, ctx);
  ctx.renderHeaderSummary();
  expect(panel.textContent).toBe("Agents 15/24 · queued 1 · ⏸ paused\nToday ≈ 91k tok (est.) · over the soft limit");
  expect(summary["aria-label"]).toContain("queued 1");
  expect(summary["aria-label"]).toContain("over the soft limit");
  expect(flags.warn).toBe(true);
  expect(host.open).toBe(true);
  S.dailyCeiling = null; S.paused = false; S.usage = 0;
  ctx.renderHeaderSummary();
  expect(flags.warn).toBe(false);
  expect(panel.textContent).toBe("Agents 15/24 · queued 1\nToday ≈ 0k tok (est.)");
  expect(host.open).toBe(true);
});
