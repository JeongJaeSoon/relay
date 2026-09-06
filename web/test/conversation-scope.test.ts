import { expect, test } from "bun:test";
import { currentMessages, currentRequestRows, isCurrentTask } from "../src/conversation-scope.ts";
import { requestRows } from "../src/ledger.ts";

let sequence = 0;
const task = (uuid: string, status: string, extra: Record<string, unknown> = {}) => ({
  uuid, status, display_id: `T-${uuid}`, parent_uuid: null, ...extra,
}) as any;
const tasks = (...all: any[]) => Object.fromEntries(all.map((task) => [task.uuid, task]));
const message = (extra: Record<string, unknown> = {}) => ({
  id: `m${++sequence}`, role: "user", source: "user", client_message_id: null, dispatch_state: "dispatched",
  text: "request", task_uuid: null, reply_to_task_uuid: null, ask: false, dispatch_json: null,
  dispatch_error: null, chain_prev_id: null, created_at: sequence, ...extra,
}) as any;
const row = (extra: Record<string, unknown> = {}) => ({
  id: `r${++sequence}`, taskUuid: null, taskUuids: [], taskIds: [], bucket: "settled", ...extra,
}) as any;

test("done remains current, while closed tasks and children of closed or missing parents move to History", () => {
  const snapshot = tasks(
    task("done", "done"), task("closed", "closed"),
    task("child-of-closed", "running", { parent_uuid: "closed" }),
    task("orphan-child", "running", { parent_uuid: "absent" }),
  );
  expect(isCurrentTask("done", snapshot)).toBe(true);
  expect(isCurrentTask("closed", snapshot)).toBe(false);
  expect(isCurrentTask("child-of-closed", snapshot)).toBe(false);
  expect(isCurrentTask("orphan-child", snapshot)).toBe(false);
});

test("messages hide closed and missing task conversations with their bare dispatcher follow-up", () => {
  const snapshot = tasks(task("live", "running"), task("closed", "closed"));
  const oldRequest = message({ id: "old", task_uuid: "closed", created_at: 1 });
  const oldPrompt = message({ id: "old-prompt", role: "system", created_at: 2, text: "Routing needs confirmation" });
  const missing = message({ id: "missing", task_uuid: "gone", created_at: 3 });
  const active = message({ id: "active", task_uuid: "live", created_at: 4 });
  const activeSummary = message({ id: "active-summary", role: "worker_summary", task_uuid: "live", created_at: 5 });
  expect(currentMessages([oldRequest, oldPrompt, missing, active, activeSummary], snapshot).map((m) => m.id))
    .toEqual(["active", "active-summary"]);
});

test("interleaved dispatcher replies follow their claimed request, never the latest user request", () => {
  const snapshot = tasks(task("archived", "closed"));
  const archived = message({ id: "archived-request", task_uuid: "archived", dispatch_state: "fastpath", created_at: 1 });
  const standalone = message({ id: "standalone-request", dispatch_state: "fastpath", created_at: 2, ask: true });
  // The dispatcher completed the older request after the newer one arrived. claimReplies pairs from the newest end.
  const oldAnswer = message({ id: "archived-answer", role: "dispatcher_answer", created_at: 3, text: "old answer" });
  const newAnswer = message({ id: "standalone-answer", role: "dispatcher_answer", created_at: 4, text: "new answer" });
  expect(currentMessages([archived, standalone, oldAnswer, newAnswer], snapshot).map((m) => m.id))
    .toEqual(["standalone-request", "standalone-answer"]);
});

test("a split stays current when any surviving piece is current", () => {
  const snapshot = tasks(task("first", "closed"), task("second", "done"));
  const split = message({ task_uuid: "first", dispatch_json: { action: "split", task_ids: ["T-first", "T-second"] } });
  expect(currentMessages([split], snapshot)).toEqual([split]);
  expect(currentRequestRows([row({ id: "split", taskUuid: "first", taskUuids: ["first", "second"], taskIds: ["T-first", "T-second"] })], snapshot)).toHaveLength(1);
  const vanishedSplit = message({ dispatch_json: { action: "split", task_ids: ["T-gone"] } });
  expect(currentMessages([vanishedSplit], snapshot)).toEqual([]);
  expect(currentRequestRows([row({ taskIds: ["T-gone"] })], snapshot)).toEqual([]);
});

test("taskless live dispatcher work remains visible, while task-bound request rows follow closure updates", () => {
  const open = tasks(task("work", "done"));
  const closed = tasks(task("work", "closed"));
  const pending = message({ id: "pending", dispatch_state: "pending" });
  const confirmation = message({ id: "confirm", dispatch_state: "needs_confirm" });
  const failed = message({ id: "failed", dispatch_state: "failed" });
  expect(currentMessages([pending, confirmation, failed], closed).map((m) => m.id)).toEqual(["pending", "confirm", "failed"]);
  const taskRow = row({ id: "work-row", taskUuid: "work", taskUuids: ["work"], taskIds: ["T-work"] });
  const standalone = row({ id: "standalone", bucket: "needs_you" });
  expect(currentRequestRows([taskRow, standalone], open).map((r) => r.id)).toEqual(["work-row", "standalone"]);
  expect(currentRequestRows([taskRow, standalone], closed).map((r) => r.id)).toEqual(["standalone"]);
});

test("a route or close candidate scopes a confirmation before task_uuid is recorded", () => {
  const closed = tasks(task("closed", "closed"));
  const live = tasks(task("live", "running"));
  const closedRoute = message({ id: "closed-route", dispatch_state: "needs_confirm", dispatch_json: { action: "route_to_task", task_id: "T-closed" } });
  const liveClose = message({ id: "live-close", dispatch_state: "needs_confirm", dispatch_json: { action: "close_task", task_id: "T-live" } });
  expect(currentMessages([closedRoute], closed)).toEqual([]);
  expect(currentMessages([liveClose], live)).toEqual([liveClose]);

  const closedRow = requestRows([closedRoute], closed)[0];
  const liveRow = requestRows([liveClose], live)[0];
  expect(closedRow).toMatchObject({ taskIds: ["T-closed"], taskUuids: ["closed"] });
  expect(liveRow).toMatchObject({ taskIds: ["T-live"], taskUuids: ["live"] });
  expect(currentRequestRows([closedRow], closed)).toEqual([]);
  expect(currentRequestRows([liveRow], live)).toEqual([liveRow]);
});
