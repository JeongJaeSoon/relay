import { expect, test } from "bun:test";
import { openDb, migrate } from "../../../src/db/db.ts";
import { assertInvariants } from "../../../src/core/state.ts";

test("assertInvariants reports I1/I2/I6/I9 violations and is silent on a healthy db", () => {
  const db = openDb(":memory:"); migrate(db); db.run("insert into projects(id,name,path,created_at) values('p','p','/p',1)");
  const task = (uuid: string, status: string, q: string | null = null) => db.run("insert into tasks(uuid,num,display_id,project_id,title,status,size,effort,model,question_json,queued_at,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,1,1)", [uuid, Number(uuid.slice(1)), uuid, "p", "t", status, "normal", "xhigh", "m", q, status === "queued" ? 1 : null]);
  task("u1", "running"); task("u2", "waiting_input", JSON.stringify({ source: "marker", text: "?", options: [], asked_at: 1 })); task("u3", "queued"); task("u4", "waiting_input", JSON.stringify({ source: "permission", text: "?", options: [], asked_at: 1 }));
  const lease = (holder: string, task: string) => db.run("insert into permit_leases(id,holder_kind,holder_id,task_uuid,acquired_at) values(?,?,?,?,1)", [holder, "task", holder, task]);
  expect(assertInvariants(db, 10)).toEqual(["I2: u1 running without a task lease"]);
  lease("task:u1", "u1"); lease("task:u2", "u2"); lease("task:u3", "u3"); lease("task:u4", "u4");
  const v = assertInvariants(db, 3);
  expect(v).toContain("I1: active leases 4 > max 3"); expect(v).toContain("I6: waiting task u2 holds a lease"); expect(v).toContain("I9: queued task u3 has no queued_at or holds a lease");
  expect(v.some((x) => x.includes("u4"))).toBe(false);                     // permission question may keep its lease
});
