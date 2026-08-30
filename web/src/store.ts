// web/src/store.ts — server frames in, one plain object out. No framework: the adapter renders through the demo engine.
import type { EventEnvelope, Message, Project, SystemState, Task, TasksSnapshot, WsFrame } from "@shared/types.ts";
export type Conn = "ok" | "reconnecting" | "resync";
export interface State { seq: number; idx: number; conn: Conn; sys: SystemState | null; projects: Project[]; tasks: Record<string, Task>; messages: Message[]; events: Record<string, EventEnvelope[]>; dirty: Dirty }
export interface Dirty { tasks: Set<string>; messages: Set<string>; events: Set<string>; sys: boolean; projects: boolean; all: boolean }
export interface Store { state: State; subscribe(fn: (f?: WsFrame) => void): () => void; applyFrame(f: WsFrame): void; applySnapshot(s: TasksSnapshot): void; setConn(c: Conn): void; drain(): Dirty; reset(): void }
const EVENTS_CAP = 200;
const freshDirty = (): Dirty => ({ tasks: new Set(), messages: new Set(), events: new Set(), sys: false, projects: false, all: false });
const initial = (): State => ({ seq: 0, idx: 0, conn: "reconnecting", sys: null, projects: [], tasks: {}, messages: [], events: {}, dirty: freshDirty() });
export function createStore(): Store {
  const state = initial(); const subs = new Set<(f?: WsFrame) => void>(); const emit = (frame?: WsFrame) => { for (const f of subs) f(frame); };   // the applied frame reaches subscribers so notification diffing can happen per frame, not per render
  const upsertMessage = (m: Message) => { const i = state.messages.findIndex((x) => x.id === m.id); if (i >= 0) state.messages[i] = m; else { state.messages.push(m); state.messages.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)); } state.dirty.messages.add(m.id); };
  return {
    state,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    applyFrame(f) {
      if (f.type !== "hello" && (f.seq < state.seq || (f.seq === state.seq && f.idx <= state.idx))) return;   // duplicate/replayed frame — compare (seq, idx), never seq alone
      if (f.type !== "hello") { state.seq = f.seq; state.idx = f.idx; }                                     // the cursor advances only with applied frames — never with hello (its replay would be dropped)
      switch (f.type) {
        case "hello": case "system.state": state.sys = f.state; state.dirty.sys = true; break;
        case "projects.updated": state.projects = f.projects; state.dirty.projects = true; break;
        case "chat.message": case "dispatch.updated": upsertMessage(f.message); break;
        case "task.created": case "task.updated": state.tasks[f.task.uuid] = f.task; state.dirty.tasks.add(f.task.uuid); break;
        case "task.event": { const list = state.events[f.task_uuid] ?? []; list.push(f.event); if (list.length > EVENTS_CAP) list.splice(0, list.length - EVENTS_CAP); state.events[f.task_uuid] = list; state.dirty.events.add(f.task_uuid); break; }
      }
      emit(f);
    },
    applySnapshot(s) {
      state.seq = s.as_of_seq; state.idx = Number.MAX_SAFE_INTEGER;                                      // every frame of as_of_seq is inside the snapshot
      state.sys = s.state; state.projects = s.projects; state.tasks = Object.fromEntries(s.tasks.map((t) => [t.uuid, t])); state.messages = [...s.messages].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
      state.dirty.all = true; emit();
    },
    setConn(c) { state.conn = c; state.dirty.sys = true; emit(); },                              // always emits: the first ws.onclose repeats the initial "reconnecting", and the dashboard must still be told it is not connected
    drain() { const d = state.dirty; state.dirty = freshDirty(); return d; },
    reset() { Object.assign(state, initial()); },
  };
}
export const store = createStore();
