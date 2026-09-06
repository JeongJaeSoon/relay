import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const code = app.slice(app.indexOf("function renderHeaderSummary(){"), app.indexOf("function renderSidebar(){"));

test("plain header activity exposes quota, pause and estimated usage without a dropdown", () => {
  const flags: any = {};
  const host: any = { textContent: "", children: [], append(...items: any[]) { this.children.push(...items); }, setAttribute(key: string, value: string) { this[key] = value; }, classList: { toggle(key: string, value: boolean) { flags[key] = value; } } };
  const S: any = { maxw: 24, usage: 91000, dailyCeiling: 100000, paused: true };
  const ctx: any = { $: () => host, S, runningCount: () => 15, tasksArr: () => [{ status: "queue" }, { status: "run" }], el: (_tag: string, cls: string, text: string) => ({ cls, text }) };
  runInNewContext(code, ctx);
  ctx.renderHeaderSummary();
  expect(host.children.map((n: any) => n.text)).toEqual(["Agents 15/24", "queued 1", "Today ≈ 91k tok (est.)", "⏸ paused ⚠"]);
  expect(host["aria-label"]).toContain("queued 1");
  expect(host["aria-label"]).toContain("over the soft limit");
  expect(flags.warn).toBe(true);
  S.dailyCeiling = null; S.paused = false; S.usage = 0; host.children=[];
  ctx.renderHeaderSummary();
  expect(flags.warn).toBe(false);
  expect(host.children.map((n: any) => n.text)).toEqual(["Agents 15/24", "queued 1", "Today ≈ 0k tok (est.)"]);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  expect(html).toContain('<div id="headerSummary"');
  expect(html).not.toContain('<details id="headerSummary"');
});
