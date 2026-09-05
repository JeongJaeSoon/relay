import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("the detail close button uses the installed selection persistence handler", () => {
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const closeBindings = app.slice(app.indexOf("function clearSel(){"), app.indexOf('document.addEventListener("keydown",e=>{', app.indexOf("function clearSel(){")));
  let click!: () => void;
  let savedSelection: string | null = "uuid-1";
  const context: any = { cleared() { savedSelection = null; }, S: { sel: "T-01", fsel: null }, refresh() {}, $: () => ({ addEventListener(_event: string, fn: () => void) { click = fn; } }) };
  // Install in the same script realm, as the browser module adapter does after button binding.
  runInNewContext(closeBindings + "\nconst originalClear=clearSel; clearSel=()=>{cleared();originalClear();};", context);
  click();
  expect(context.S.sel).toBeNull(); expect(savedSelection).toBeNull();
});
