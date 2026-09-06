import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

test("palette trigger state and visible close controls follow the existing modal focus behavior", () => {
  const nodes = new Map<string, any>(); let focused = "";
  const node = (id: string) => {
    if (!nodes.has(id)) {
      const classes = new Set<string>();
      nodes.set(id, { attributes: {}, handlers: {}, value: "old search",
        classList: { contains: (name: string) => classes.has(name), add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
        setAttribute(name: string, value: string) { this.attributes[name] = value; },
        addEventListener(name: string, fn: () => void) { this.handlers[name] = fn; }, focus() { focused = id; },
      });
    }
    return nodes.get(id);
  };
  const c: any = { $: node, PAL: { open: false, idx: 3 }, N: { open: true }, SET: { open: true },
    palEl: node("#palette"), palInput: node("#palInput"), kedEl: node("#keysEd"),
    captureFocus: () => ({ key: "origin" }), renderNotif() {}, renderSettings() {}, renderPal() {}, syncOverlayAccess() {},
    focusComposer: () => focused = "composer", restoreFocus: () => focused = "origin",
  };
  const open = source.slice(source.indexOf("function openPalette(){"), source.indexOf('$("#palBtn").addEventListener'));
  const close = ["closePalette", "closeKeysEd"].map(name => source.match(new RegExp(`^function ${name}\\(.*$`, "m"))![0]).join("\n");
  const buttons = ["palClose", "kedDismiss"].map(id => source.split("\n").find(line => line.startsWith(`$("#${id}").addEventListener`))!).join("\n");
  runInNewContext(open + close + buttons, c);
  c.openPalette();
  expect(c.PAL.open).toBe(true); expect(node("#palBtn").attributes["aria-expanded"]).toBe("true");
  expect(focused).toBe("#palInput"); expect(c.palInput.value).toBe("");
  node("#palClose").handlers.click();
  expect(c.PAL.open).toBe(false); expect(node("#palBtn").attributes["aria-expanded"]).toBe("false");
  expect(focused).toBe("composer");
  node("#keysEd").classList.add("open"); node("#kedDismiss").handlers.click();
  expect(node("#keysEd").classList.contains("open")).toBe(false); expect(focused).toBe("composer");
});
