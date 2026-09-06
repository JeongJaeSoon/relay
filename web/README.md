# Dashboard development

The dashboard uses vanilla browser JavaScript and a typed WebSocket adapter. It has no runtime
UI framework dependency. `bun run build:web` bundles the production adapter and inlines the
page into `web/dist/index.html`, which is embedded in the Relay binary.

| File | Responsibility |
|---|---|
| `index.html` | Layout, styles and semantic controls |
| `src/app.js` | Canvas, panels, chat rendering and interaction |
| `src/adapter.ts` | Snapshot/event projection into UI state and stable message attribution |
| `src/ledger.ts` | Request and conversation ledger derivation |
| `src/main.ts` | Production bootstrap |
| `test/` | Browser-model regression tests |

Run `bun run dev:ui` for synthetic layouts at localhost:8813 (`?dark`, `?empty`) or
`bun run dev:fake` for the real HTTP/WS pipeline with scripted workers at localhost:8814.
Use `bun run test:web` for adapter/replay tests and `bun run check` before a PR.

Validate desktop and narrow layouts, panel resizing/collapse, canvas pan/zoom, request-to-chat
navigation, readable sender identity, timestamp/day boundaries, history replay and keyboard focus.
Agent messages use task identity; system and dispatcher messages retain the Relay sender label.
Do not infer agent ownership from message text or historical display IDs.

Dated browser evidence and design journals are preserved in the Obsidian `Project/relay` hub.
The current contributor and runtime contracts live in `docs/development.md` and
`docs/architecture.md`; operational validation is described in `test/README.md`.
