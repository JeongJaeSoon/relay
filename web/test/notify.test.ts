import { expect, test } from "bun:test";
import { diffNotifs } from "../src/notify.ts";
const t = (status: any, extra: Record<string, unknown> = {}) => ({ uuid: "u", title: "auth", status, parent_uuid: null, question: null, last_summary: null, ...extra }) as any;
test("status transitions produce and withdraw notifications", () => {
  expect(diffNotifs(t("running"), t("waiting_input", { question: { text: "a or b?" } })).add).toEqual([{ kind: "wait", taskUuid: "u", title: "auth", body: "a or b?" }]);
  expect(diffNotifs(t("waiting_input"), t("running")).withdraw).toEqual([{ taskUuid: "u", kind: "wait" }]);
  expect(diffNotifs(t("running"), t("error")).add[0].kind).toBe("err"); expect(diffNotifs(t("error"), t("starting")).withdraw).toEqual([{ taskUuid: "u", kind: "err" }]);
  expect(diffNotifs(t("running"), t("done", { last_summary: "ok" })).add[0]).toMatchObject({ kind: "done", body: "ok" });
  expect(diffNotifs(t("error"), t("queued")).withdraw).toEqual([{ taskUuid: "u", kind: "err" }]);   // retry without a free permit lands in the queue first
  expect(diffNotifs(t("done"), t("closed")).withdraw).toEqual([{ taskUuid: "u" }]);
  expect(diffNotifs(t("running", { parent_uuid: "p" }), t("done", { parent_uuid: "p" })).add).toEqual([]);
  expect(diffNotifs(t("running"), t("running", { last_step: "x" })).add).toEqual([]);
});
