import { describe, expect, test } from "bun:test";
import { parseMarker, verdict } from "../../../src/core/verdict.ts";
import { chatFor } from "../../../src/core/promote.ts";
import done from "../../fixtures/stop-done.json"; import question from "../../fixtures/stop-question.json"; import background from "../../fixtures/stop-background.json"; import blocked from "../../fixtures/stop-blocked.json";

const task: any = { uuid: "u", display_id: "T-01", title: "auth", project_id: "p", question: null, status: "running" };
describe("verdict", () => {
  test("marker parsing", () => {
    expect(parseMarker("details\n\nRELAY: done\nRefactored auth. Files: a.ts. Verified: bun test.")).toEqual({ kind: "done", body: "Refactored auth. Files: a.ts. Verified: bun test.", options: [] });
    expect(parseMarker("RELAY: question\nWhich name?\n- a.txt\n- b.txt")).toEqual({ kind: "question", body: "Which name?", options: ["a.txt", "b.txt"] });
    expect(parseMarker("no marker here")).toBeNull();
  });
  test("fixtures → statuses", () => {
    expect(verdict(done as any, task).status).toBe("done"); expect(verdict(done as any, task).summary).toMatch(/\S/);
    const q = verdict(question as any, task); expect(q.status).toBe("waiting_input"); expect(q.question!.options.length).toBe(2);
    expect(verdict(background as any, task).status).toBe("running");
    expect(verdict(blocked as any, task).status).toBe("waiting_input"); expect(verdict(blocked as any, task).question!.text).toMatch(/^Blocked/);
  });
  test("missing marker → needs_review with fallback summary; empty message → needs_review", () => {
    const v = verdict({ last_assistant_message: "I did things.\nMore.", background_tasks: [], session_crons: [] } as any, task);
    expect(v.status).toBe("needs_review"); expect(v.summary).toBe("I did things.");
    expect(verdict({ last_assistant_message: "", background_tasks: [], session_crons: [] } as any, task).status).toBe("needs_review");
  });
  test("pending permission question survives a Stop without marker", () => {
    const v = verdict({ last_assistant_message: "waiting", background_tasks: [], session_crons: [] } as any, { ...task, status: "waiting_input", question: { source: "permission", text: "x", options: [], asked_at: 1 } });
    expect(v.status).toBe("waiting_input");
  });
  test("chatFor roles", () => {
    expect(chatFor("completed", task, "done!").role).toBe("worker_summary"); expect(chatFor("question", task, "q?").role).toBe("question"); expect(chatFor("error", task, "boom").role).toBe("error"); expect(chatFor("started", task, "").text).toContain("T-01");
  });
});
