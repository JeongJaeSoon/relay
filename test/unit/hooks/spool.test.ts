import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestApp } from "../../helpers/app.ts";
import { Spool } from "../../../src/hooks/spool.ts";
import { loadTask } from "../../../src/core/events.ts";
import { setMeta } from "../../../src/db/db.ts";
test("drain feeds spooled hooks into ingest (replay), quarantines malformed files, sweep removes old ones", async () => {
  const s = await buildTestApp(); const t = s.seedTask("running"); const dir = mkdtempSync(join(tmpdir(), "relay-spool-"));
  const rec = (id: string, body: unknown) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, received_at: 1, headers: { "x-relay-task": t }, body }));
  rec("a", { hook_event_name: "PostToolUse", session_id: "sid1", tool_name: "Bash", tool_use_id: "tu1", tool_input: { command: "ls" }, tool_response: "", transcript_path: "/t", cwd: "/tmp/myapp" });
  rec("b", { hook_event_name: "PermissionRequest", session_id: "sid1", tool_name: "Bash", tool_use_id: "tu2", tool_input: { command: "rm -rf x" }, transcript_path: "/t", cwd: "/tmp/myapp" });
  writeFileSync(join(dir, "c.json"), "{not json");
  const spool = new Spool(dir, () => s.svc.ingestDeps);
  expect(await spool.drain()).toBe(2);
  expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]); expect(readdirSync(join(dir, "quarantine"))).toEqual(["c.json"]);
  expect(loadTask(s.db, t)!.last_step).toBe("Bash ls"); expect(loadTask(s.db, t)!.status).toBe("running");   // replayed PermissionRequest is recorded, never held
  expect(s.ctx.services.pendingPermissions.size).toBe(0);
  const old = new Date(Date.now() - 8 * 86400_000); utimesSync(join(dir, "quarantine", "c.json"), old, old);
  expect(spool.sweep(7)).toBe(1);
});

test("the periodic spool drain waits for the recovery owner to replay the merged buffers", async () => {
  const s = await buildTestApp(); const t = s.seedTask("running"); const dir = mkdtempSync(join(tmpdir(), "relay-spool-barrier-"));
  writeFileSync(join(dir, "final.json"), JSON.stringify({ received_at: 1, headers: { "x-relay-task": t, "x-relay-gen": "1" }, body: { session_id: "sid1", hook_event_name: "Stop", prompt_id: "done", last_assistant_message: "RELAY: done\nComplete" } }));
  setMeta(s.db, "recovering", "1"); const spool = new Spool(dir, () => s.svc.ingestDeps);
  expect(await spool.drain()).toBe(0); expect(loadTask(s.db, t)!.status).toBe("running"); expect(spool.files()).toEqual(["final.json"]);
  expect(await spool.drain({ includeInbox: true })).toBe(1); expect(loadTask(s.db, t)!.status).toBe("done");
});
