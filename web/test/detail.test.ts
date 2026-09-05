import { expect, test } from "bun:test";
import { createDetailLoader } from "../src/adapter.ts";

test("failed detail loads can retry, while successful loads keep their fast path", async () => {
  let calls = 0;
  const load = createDetailLoader(async () => { if (++calls === 1) throw new Error("offline"); return { events: [] }; });
  await expect(load("a")!).rejects.toThrow("offline");
  expect(await load("a")).toEqual({ events: [] });
  expect(load("a")).toBeNull(); expect(calls).toBe(2);
});

test("an obsolete detail failure cannot evict a newer selection of the same task", async () => {
  let rejectOld!: (error: Error) => void; let calls = 0;
  const load = createDetailLoader(() => ++calls === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : Promise.resolve({ events: [] }));
  const old = load("a")!.catch(() => {});
  await load("b"); await load("a"); rejectOld(new Error("old request")); await old;
  expect(load("a")).toBeNull(); expect(calls).toBe(3);
});
