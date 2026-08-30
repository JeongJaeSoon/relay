import { z } from "zod";
import type { DispatchDecision } from "@shared/types.ts";

const ItemSchema = z.object({
  action: z.enum(["new_task", "route_to_task"]),
  task_id: z.string().optional(), project: z.string().optional(), title: z.string().max(60).optional(),
  size: z.enum(["small", "normal", "epic"]).optional(), prompt: z.string(),
  confidence: z.enum(["high", "low"]).optional(),
}).superRefine((it, ctx) => {
  if (it.action === "new_task" && (!it.project || !it.title || !it.size)) ctx.addIssue({ code: "custom", message: "split item new_task needs project/title/size" });
  if (it.action === "route_to_task" && !it.task_id) ctx.addIssue({ code: "custom", message: "split item route_to_task needs task_id" });
});

export const DecisionSchema = z.object({
  action: z.enum(["new_task", "route_to_task", "answer_directly", "close_task", "split"]),
  task_id: z.string().optional(), project: z.string().optional(), title: z.string().max(60).optional(),
  size: z.enum(["small", "normal", "epic"]).optional(), prompt: z.string().optional(), answer: z.string().optional(),
  items: z.array(ItemSchema).optional(),
  confidence: z.enum(["high", "low"]),
}).superRefine((d, ctx) => {
  if (d.action === "new_task" && (!d.project || !d.title || !d.size)) ctx.addIssue({ code: "custom", message: "new_task needs project/title/size" });
  if ((d.action === "route_to_task" || d.action === "close_task") && !d.task_id) ctx.addIssue({ code: "custom", message: "task_id required" });
  if (d.action === "answer_directly" && !d.answer) ctx.addIssue({ code: "custom", message: "answer required" });
  if (d.action === "split" && !d.items?.length) ctx.addIssue({ code: "custom", message: "split needs items" });
});

/** A split is all-or-nothing (design C.4.2): one unsure piece makes the whole message unsure. */
export const lowConfidence = (d: DispatchDecision) => d.confidence === "low" || (d.items ?? []).some((i) => i.confidence === "low");

/** Everything a split must clear BEFORE the first event is emitted; returns the reason it must not run, or null.
 *  Project resolution is the one check that needs the database, so it stays in TaskService (design C.4.3). */
export function splitGuard(d: DispatchDecision, maxSplit: number): string | null {
  const items = d.items ?? [];
  if (maxSplit < 2) return "splitting is off (dispatcher.max_split = 1)";
  if (!items.length) return "split with no items";
  if (items.length > maxSplit) return `split of ${items.length} exceeds dispatcher.max_split = ${maxSplit}`;
  if (lowConfidence(d)) return "confidence=low on at least one item";
  for (const [i, it] of items.entries()) {
    if (!it.prompt) return `split item ${i + 1}: prompt required`;
    if (it.action === "new_task" && (!it.project || !it.title || !it.size)) return `split item ${i + 1}: new_task needs project/title/size`;
    if (it.action === "route_to_task" && !it.task_id) return `split item ${i + 1}: route_to_task needs task_id`;
  }
  return null;
}

const ACTIONS = ["new_task", "route_to_task", "answer_directly", "close_task"];
const ITEM = {
  type: "object", additionalProperties: false,
  properties: { action: { type: "string", enum: ["new_task", "route_to_task"] }, task_id: { type: "string" }, project: { type: "string" }, title: { type: "string" },
    size: { type: "string", enum: ["small", "normal", "epic"] }, prompt: { type: "string" }, confidence: { type: "string", enum: ["high", "low"] } },
  required: ["action", "prompt"],
};

/** Passed to `claude -p --json-schema`; zod re-validates the structured output (belt and braces).
 *  `max_split = 1` is the off switch: the model is never even offered the action (design C.4.1). */
export const dispatchJsonSchema = (maxSplit: number) => ({
  type: "object", additionalProperties: false,
  properties: { action: { type: "string", enum: maxSplit > 1 ? [...ACTIONS, "split"] : ACTIONS }, task_id: { type: "string" }, project: { type: "string" }, title: { type: "string" },
    size: { type: "string", enum: ["small", "normal", "epic"] }, prompt: { type: "string" }, answer: { type: "string" }, confidence: { type: "string", enum: ["high", "low"] },
    ...(maxSplit > 1 ? { items: { type: "array", maxItems: maxSplit, items: ITEM } } : {}) },
  required: ["action", "confidence"],
});
