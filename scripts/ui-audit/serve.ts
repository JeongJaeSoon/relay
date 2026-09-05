// Isolated visual audit: invented data only; never load the production adapter.
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const html = readFileSync(new URL("web/index.html", root), "utf8");
const fixture = readFileSync(new URL("fixture.js", import.meta.url), "utf8");
const port = Number(process.env.RELAY_UI_AUDIT_PORT || 8813);
Bun.serve({
  hostname: "127.0.0.1", port,
  fetch() {
    const js = readFileSync(new URL("web/src/app.js", root), "utf8");
    return new Response(html
      .replace('<script src="./src/app.js"></script>', () => `<script>${js}</script>`)
      .replace('<script type="module" src="./src/main.ts"></script>', () => `<script>${fixture}</script>`),
      { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log(`Synthetic UI audit: http://127.0.0.1:${port}/ (?dark or ?empty)`);
