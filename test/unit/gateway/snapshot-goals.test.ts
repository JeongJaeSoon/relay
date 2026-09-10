import { expect, test } from "bun:test";
import { openDb, migrate } from "../../../src/db/db.ts";
import { parseConfig } from "../../../src/config.ts";
import { snapshot } from "../../../src/gateway/snapshot.ts";

test("snapshot keeps completed goals visible independently until review", () => {
  const db = openDb(":memory:"); migrate(db);
  const request = { message_id: "m1", source: "user", client_message_id: "c1", text: "ship both", ask: false, created_at: 1 };
  db.run("insert into goals(id,request_message_id,original_request_json,status,current_generation,outcome,created_at,updated_at,completed_at,reviewed_at) values('g1','m1',?,'completed',1,'completed',1,2,2,null)", [JSON.stringify(request)]);
  db.run("insert into goal_cycles(goal_id,generation,status,outcome,opened_at,completed_at,member_states_json) values('g1',1,'completed','completed',1,2,'[]')");
  db.run("insert into goal_members(goal_id,split_item_id,ordinal,task_uuid,task_display_id,created_at) values('g1','m1:0',0,'gone-task','T-01',1)");
  db.run("insert into goal_notification_claims(claim_id,goal_id,generation,outcome,task_uuids_json,state,claimed_at,completion_event_id) values('c','g1',1,'completed','[\"gone-task\"]','pending',2,'e')");
  const visible = snapshot(db, parseConfig(""));
  expect(visible.tasks).toEqual([]); expect(visible.goals.map((g) => g.id)).toEqual(["g1"]); expect(visible.goal_members.map((m) => m.task_display_id)).toEqual(["T-01"]); expect(visible.goal_notifications.map((n) => n.claim_id)).toEqual(["c"]);
  db.run("update goals set reviewed_at=3 where id='g1'");
  expect(snapshot(db, parseConfig("")).goals).toEqual([]);
});
