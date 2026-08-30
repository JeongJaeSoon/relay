// scripts/build-web.ts — one self-contained HTML: demo markup+CSS, app.js inlined as a classic script, the TS bundle inlined as a module.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const root = new URL("../web/", import.meta.url).pathname;
const html = readFileSync(root + "index.html", "utf8");
const appJs = readFileSync(root + "src/app.js", "utf8");
const out = await Bun.build({ entrypoints: [root + "src/main.ts"], target: "browser", format: "esm", minify: false, define: { "process.env.NODE_ENV": '"production"' } });
if (!out.success) { for (const m of out.logs) console.error(m); process.exit(1); }
const bundle = await out.outputs[0].text();
const inline = (src: string) => src.replace(/<\/script/g, "<\\/script");   // never close the tag early
const page = html
  .replace('<script src="./src/app.js"></script>', `<script>${inline(appJs)}</script>`)
  .replace('<script type="module" src="./src/main.ts"></script>', `<script type="module">${inline(bundle)}</script>`);
if (page === html) { console.error("build-web: script tags not found in web/index.html"); process.exit(1); }
mkdirSync(root + "dist", { recursive: true }); writeFileSync(root + "dist/index.html", page);
console.log(`web/dist/index.html ${(page.length / 1024).toFixed(0)} KB`);
