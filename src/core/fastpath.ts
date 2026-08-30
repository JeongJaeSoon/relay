import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import { rowToTask, systemState } from "./projections.ts";
import { now } from "./clock.ts";

// Roadmap B6. A false positive (swallowing a request as a status answer) is worse than a false negative
// (one more dispatcher call), so anything that carries a work verb, a destructive imperative or a negation
// goes to the dispatcher.
const INTENT = /(상태|현황|진행\s*상황|뭐\s*(하고|돌아가|만들고)|무슨\s*일|돌아가|실행\s*중|대기열|큐|사용량|몇\s*개|끝났|완료됐|어디까지|status|running|queue|what.?s (running|going on)|done yet)/i;
const ACTION = /(해\s*줘|해줘|고쳐|만들어|추가|수정|구현|리팩|삭제|점검|테스트|배포|작성|바꿔|올려|내려|정리|설치|실행해|돌려|보내|합쳐|머지|리뷰|\bfix\b|\badd\b|\bimplement\b|\brefactor\b|\bdeploy\b|\bwrite\b|\bcreate\b|\brun )/i;
const DESTRUCTIVE = /(비워|비우|줄여|늘려|초기화|리셋|취소|멈춰|중단|지워|없애|끊어|재시작|다시 시작|clear|reset|cancel|stop|kill|restart)/i;
const NEGATION = /(안|못|없|not)\s/;

export function isStatusQuery(text: string, replyTo: string | null = null): boolean {
  if (replyTo) return false;
  const t = text.trim().replace(/[?？!.,~]/g, "");
  return t.length <= 40 && INTENT.test(t) && !ACTION.test(t) && !DESTRUCTIVE.test(t) && !NEGATION.test(t + " ");
}

const rel = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);

export function statusAnswer(db: Database, cfg: Config): string {
  const s = systemState(db, cfg);
  const waiting = (db.query("select count(*) c from tasks where status='waiting_input'").get() as any).c;
  const head = `Running ${s.running} · Queued ${s.queued} · Needs input ${waiting} · today ~${Math.round(s.today_tokens / 1000)}k tok (est.)${s.paused ? " · kill switch ON" : ""}`;
  const rows = db.query("select * from tasks where parent_uuid is null and status not in ('closed') order by num desc limit 12").all().map(rowToTask);
  const lines = rows.map((t) => `${t.display_id} ${t.title} · ${t.status}${t.started_at ? " " + rel((t.ended_at ?? now()) - t.started_at) : ""}${t.last_step ? " · last: " + t.last_step : ""}`);
  return [head, ...lines].join("\n");
}
