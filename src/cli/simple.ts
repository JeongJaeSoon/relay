import { arg, client, has, CliError } from "./client.ts";
const rel = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);
const width = (c: string) => Bun.stringWidth(c);                              // full-width (Korean) aware — padEnd is not
const pad = (c: string, w: number) => c + " ".repeat(Math.max(0, w - width(c)));
export async function send(rest: string[]) { const text = rest.filter((x, i) => !(x === "--to" || rest[i - 1] === "--to")).join(" ").trim(); if (!text) throw new CliError('usage: relay send "<message>" [--to <task>]', 2);
  const r = await client().post("/messages", { text, client_message_id: crypto.randomUUID(), source: "cli", ...(arg(rest, "--to") ? { reply_to_task_id: await resolveTask(arg(rest, "--to")!) } : {}) }); process.stdout.write(`접수 ${r.message_id}\n`); }
export async function resolveTask(idOrDisplay: string): Promise<string> { if (/^[0-9a-f-]{36}$/.test(idOrDisplay)) return idOrDisplay; const s = await client().get("/tasks?include=closed"); const t = s.tasks.find((x: any) => x.display_id === idOrDisplay.toUpperCase() || x.uuid.startsWith(idOrDisplay)); if (!t) throw new CliError(`relay: 태스크를 찾을 수 없음: ${idOrDisplay}`); return t.uuid; }
export async function ls(rest: string[]) { const s = await client().get(has(rest, "--all") ? "/tasks?include=closed" : "/tasks"); if (has(rest, "--json")) { process.stdout.write(JSON.stringify(s.tasks, null, 2) + "\n"); return; }
  const pn = (id: string) => s.projects.find((p: any) => p.id === id)?.name ?? id; const rows: string[][] = s.tasks.filter((t: any) => !t.parent_uuid).map((t: any) => [t.display_id, t.status, pn(t.project_id), t.title.slice(0, 40), t.started_at ? rel((t.ended_at ?? Date.now()) - t.started_at) : "—", t.short_id ?? "—"]);
  const head = ["ID", "상태", "프로젝트", "제목", "경과", "세션"]; const w = head.map((h, i) => Math.max(width(h), ...rows.map((r) => width(String(r[i])))));
  for (const r of [head, ...rows]) process.stdout.write(r.map((c, i) => pad(String(c), w[i])).join("  ") + "\n"); if (!rows.length) process.stdout.write("(태스크 없음)\n"); }
export async function tail(rest: string[]) { const uuid = await resolveTask(rest[0] ?? ""); const c = client(); const snap = await c.get("/tasks?include=closed"); process.stdout.write(`tail ${uuid} (Ctrl-C로 종료)\n`);
  await new Promise<void>((done) => c.ws(snap.as_of_seq, (f) => {                                     // from as_of_seq: only what happens from now on, never the whole history
    if (f.type === "task.event" && f.task_uuid === uuid) process.stdout.write(`${new Date(f.event.occurred_at).toLocaleTimeString("ko-KR", { hour12: false })}  ${f.event.type}  ${JSON.stringify(f.event.payload).slice(0, 160)}\n`);
    if (f.type === "task.updated" && f.task.uuid === uuid) process.stdout.write(`  → ${f.task.status}${f.task.last_step ? " · " + f.task.last_step : ""}\n`);
  }, () => { console.error("relay: 연결 종료"); done(); })); }
export async function open() { const c = client(); Bun.spawn(["open", `${c.base}/`]); process.stdout.write(`${c.base}/\n`); }
export async function pause() { await client().post("/pause"); process.stdout.write("kill switch ON — 새 디스패치 중단, 실행 중 워커 정지 요청\n"); }
export async function resumeAll() { await client().post("/resume-all"); process.stdout.write("kill switch OFF — 재개\n"); }
