import { describe, expect, test } from "bun:test";
import { isStatusQuery, statusAnswer } from "../../../src/core/fastpath.ts";
import { openDb, migrate } from "../../../src/db/db.ts";
import { parseConfig } from "../../../src/config.ts";

// Roadmap B6 decision table, all 25 rows.
const YES = ["상태?", "지금 상태 어때", "현황 알려줘", "뭐 돌아가고 있어?", "대기열 몇 개야", "실행 중인 거 있어?", "status", "what's running", "오늘 사용량", "진행 상황은?", "그거 상태 어때", "무슨 일 하고 있어?", "다 끝났어?", "지금 뭐 만들고 있어?"];
const NO = ["인증 상태 점검해줘", "상태 페이지 만들어줘", "status 필드 추가", "현황판 컴포넌트 고쳐줘", "실행 중인 테스트 멈춰줘", "대기열 순서 바꿔", "T-03 상태 자세히 설명해줘, 왜 멈췄는지 알고 싶어서 그래", "사용량 리포트 작성", "running 표시가 안 보여", "큐 비워줘", "사용량 줄여줘", "대기열 초기화", "실행 중인 거 취소해"];

describe("fastpath", () => {
  test.each(YES)("fast-path: %s", (t) => expect(isStatusQuery(t)).toBe(true));
  test.each(NO)("dispatcher: %s", (t) => expect(isStatusQuery(t)).toBe(false));
  test("reply_to_task never fast-paths", () => expect(isStatusQuery("상태?", "uuid")).toBe(false));
  test("over 40 characters is never a fast-path", () => expect(isStatusQuery("상태 " + "가".repeat(40))).toBe(false));
  test("answer summarises counts and tasks", () => {
    const db = openDb(":memory:"); migrate(db);
    expect(statusAnswer(db, parseConfig(""))).toMatch(/실행 중 0 · 대기 0 · 응답 대기 0/);
  });
});
