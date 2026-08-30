import { z } from "zod";

export const DecisionSchema = z.object({
  action: z.enum(["new_task", "route_to_task", "answer_directly", "close_task"]),
  task_id: z.string().optional(), project: z.string().optional(), title: z.string().max(60).optional(),
  size: z.enum(["small", "normal", "epic"]).optional(), prompt: z.string().optional(), answer: z.string().optional(),
  confidence: z.enum(["high", "low"]),
}).superRefine((d, ctx) => {
  if (d.action === "new_task" && (!d.project || !d.title || !d.size)) ctx.addIssue({ code: "custom", message: "new_task needs project/title/size" });
  if ((d.action === "route_to_task" || d.action === "close_task") && !d.task_id) ctx.addIssue({ code: "custom", message: "task_id required" });
  if (d.action === "answer_directly" && !d.answer) ctx.addIssue({ code: "custom", message: "answer required" });
});

/** Passed to `claude -p --json-schema`; zod re-validates the structured output (belt and braces). */
export const DISPATCH_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { action: { type: "string", enum: ["new_task", "route_to_task", "answer_directly", "close_task"] }, task_id: { type: "string" }, project: { type: "string" }, title: { type: "string" },
    size: { type: "string", enum: ["small", "normal", "epic"] }, prompt: { type: "string" }, answer: { type: "string" }, confidence: { type: "string", enum: ["high", "low"] } },
  required: ["action", "confidence"],
};
