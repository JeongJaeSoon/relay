import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const section = app.split("/* ================= shortcuts (customised as JSON) ================= */")[1]
  .split("/* ================= command palette ================= */")[0];
function shortcuts(platform: string, saved?: object) {
  let handler: any, opened = 0;
  const nodes: Record<string, any> = { "#palBtn": {}, "#paletteHint": {} };
  const context: any = {
    navigator: { platform }, localStorage: { getItem: () => saved ? JSON.stringify(saved) : null },
    $: (id: string) => nodes[id], document: { addEventListener: (_: string, fn: any) => handler = fn },
    PAL: { open: false }, togglePalette: () => opened++,
  };
  runInNewContext(section, context);
  return { nodes, press(key: string, modifiers: object = {}) {
    let prevented = false;
    handler({ key, ...modifiers, preventDefault() { prevented = true; } });
    return { opened, prevented };
  } };
}

test("palette defaults to Cmd K on macOS and Ctrl K elsewhere, with matching hints", () => {
  for (const [platform, modifiers, label] of [["MacIntel", { metaKey: true }, "⌘K"], ["Linux", { ctrlKey: true }, "Ctrl+K"]] as const) {
    const c = shortcuts(platform);
    expect(c.nodes["#palBtn"].title).toBe(`Command palette (${label})`);
    expect(c.nodes["#paletteHint"].textContent).toBe(`Use ${label} for commands.`);
    expect(c.press("k", modifiers)).toEqual({ opened: 1, prevented: true });
    expect(c.press("p", { ...modifiers, shiftKey: true })).toEqual({ opened: 1, prevented: false });
  }
});

test("saved palette overrides remain active and appear in the shortcut hints", () => {
  const c = shortcuts("MacIntel", { palette: "mod+shift+p" });
  expect(c.nodes["#palBtn"].title).toBe("Command palette (⌘⇧P)");
  expect(c.nodes["#paletteHint"].textContent).toBe("Use ⌘⇧P for commands.");
  expect(c.press("k", { metaKey: true })).toEqual({ opened: 0, prevented: false });
  expect(c.press("P", { metaKey: true, shiftKey: true })).toEqual({ opened: 1, prevented: true });
  const disabled = shortcuts("MacIntel", { palette: "" });
  expect(disabled.nodes["#palBtn"].title).toBe("Command palette");
  expect(disabled.nodes["#paletteHint"].textContent).toBe("Open Command palette from the toolbar.");
  expect(disabled.press("k", { metaKey: true })).toEqual({ opened: 0, prevented: false });
});
