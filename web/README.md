# relay dashboard — browser QA

Vanilla dashboard: the demo engine (`src/app.js`) rendered from server state by six TS modules
(`consts`/`store`/`ws`/`api`/`notify`/`ledger`/`adapter`), built into one self-contained
`web/dist/index.html` by `scripts/build-web.ts`. Zero runtime dependencies, zero external references.

```
bun run build:web                 # → web/dist/index.html (98 KB, no external refs)
bun scripts/dev-fake.ts           # real server + FakeRunner sessions → http://127.0.0.1:8790/
bun test web/test                 # pure modules (store / ws / notify / ledger / adapter)
```

The server reads `web/dist/index.html` per request and injects `<meta name="relay-token">` into
`<head>`, so the dev loop is edit → `bun run build:web` → reload.

`scripts/dev-fake.ts` drives a real server with scripted hook sequences instead of real Claude
sessions (`RELAY_HOME=~/.config/relay-fake`, project `myapp` at `/tmp/relay-fake/myapp`). Prompts:
`myapp … 리팩토링` (normal), `질문` (question), `에픽` (2 subagents), `오류` (crash), `후속:`
(route_to_task), `상태?` (fast-path).

## Request ledger

The chat's right rail is one row per user message: the request, what relay did with it
(`web/src/ledger.ts`, `requestRows(messages, tasks)`), the live state of that disposition, the answer
if one came back, and the action that unblocks it. Ordered needs-you first, filtered to Open by
default. It replaced the dispatch log, which said what the dispatcher decided and never said whether
an answer came back. Pure derivation over the snapshot the client already holds — no server change.

### Results — 2026-08-31, Chrome, `bun scripts/dev-fake.ts` (isolated RELAY_HOME, port 8801)

| 상태 | 행 | 결과 |
|---|---|---|
| `needs_confirm` (task not found) | `follow-up: add tests too` | PASS — Waiting for you · "Routing needs confirmation (task T-01 not found…)" · Retry |
| `needs_confirm` (target in error) | `follow-up: 그거 마저 해줘` | PASS — 확인 프롬프트 본문 + T-01 칩 · Retry/Restart (디스패처 배지 행이 아니라 프롬프트를 집는다) |
| `dispatched` → task errored | `follow-up: 테스트도 붙여줘` | PASS — Routed into T-01 · Error · Restart → 재개 후 행이 settled로 이동 |
| `dispatched` `new_task` | `myapp 질문 있는 작업` | PASS — Needs input · 질문 본문 · `a.txt`/`b.txt` chip → 답변 후 Running, 카운트 8 → 7 |
| `dispatched` `close_task` | `close T-01` | PASS — Close 요청 · Close 액션, 대상이 done이 되자 Restart만 사라짐 |
| `fastpath` | `status?` | PASS — Answered from the status fast path · 즉답 본문 |
| `dispatched` `answer_directly` | `hello there` | PASS — Answered by the dispatcher · `dispatch_json.answer` |
| `failed` | (fake db에 주입) | PASS — Failed · `timeout` · `slack` source 배지 · Retry |
| 필터/빈 상태 | — | PASS — Open 11→8행, All 11행, "Nothing open" + "Show all N", 초기 빈 문구 |
| 외부 세션과 공존 | `RELAY_FAKE_FOREIGN=2` | PASS — 태스크 노드 3 + 외부 세션 노드 2(자체 열·점선·게이트웨이 엣지 없음), 사이드바 `Outside relay 2`, 원장 11행/7 need you가 동시에 정상. 외부 세션은 원장 행이 되지 않고(`S.foreign` 키가 `S.tasks`에 0건) 액션 대상도 되지 않는다. 상세 패널 배타성 양방향 확인: 외부 노드 → `Session detail · outside relay`, 원장의 T-01 칩 → `Task detail`(`fsel` 해제) |

### QA에서 고친 것 (main 선재 버그)

승격된 `question` 채팅 행은 태스크가 이미 `waiting_input`을 떠난 뒤에도 스냅숏에 남는다. 어댑터는
`m.role === "question" && task`만 보고 `chatQuestion(t)`을 불렀고, 이 함수는 `t.question.q`를 읽는다 —
`toDemoTask`는 `waiting_input`일 때만 `question`을 채우므로 **질문에 답한 뒤 새로고침하면**
`TypeError: Cannot read properties of null (reading 'q')`가 `syncMessages` 안에서 터지고, 그 프레임의
`sync()`가 통째로 중단돼 그래프·사이드바·원장이 아무것도 그려지지 않는다. `task?.question`으로 좁히고
질문이 없으면 아래의 일반 채팅 행으로 떨어뜨린다(그 행의 텍스트가 이미 `❓ T-03 …`이다).

이 줄은 `d9f5b8e`(어댑터 최초 커밋) 이후 그대로였고 `origin/main`과 동일하다 — 이 브랜치가 만든 회귀가
아니라, 이 브랜치 검증 중에 드러난 것이다.

Console stayed clean. `failed`와 "라우팅 직후 대상이 error가 되는" 두 형태는 FakeRunner가 스크립트를
HTTP 왕복보다 빨리 끝내 재현이 레이스가 되므로, **fake db**에 직접 써서 렌더 경로만 확인했다
(사용자의 실제 `~/.config/relay/relay.db`는 읽지도 쓰지도 않았다).

## Results — 2026-08-31, Chrome, `bun scripts/dev-fake.ts`

| # | 시나리오 | 결과 |
|---|---|---|
| 1 | `myapp auth 리팩토링 해줘` | PASS — ⏳ 접수 → 배지(new_task·normal·myapp·T-01) → 노드 슬라이드-인 → 실행 캡션(Read/Edit/Bash) → 완료 요약 + done 토스트 → 벨 보관함 |
| 2 | `후속: 테스트도 추가해` | PASS — route_to_task 배지 + T-01 태그, 노드 실행 중 복귀(gen 2), 타임라인 `전달 accepted (resume)` |
| 3 | `myapp 질문 있는 작업` | PASS — wait 토스트·채팅 chip·상세 chip → chip 클릭 → 답장, chip 비활성, 알림 자동 철회, 노드 재개 후 완료 |
| 4 | `myapp 에픽 작업` | PASS — 서브 노드 2개(`relay-explore`, 오른쪽 열), 부모 선택 시 가족 포커스(sel/rel/dim), 서브 done 후 부모 done, 서브에이전트 알림 없음 |
| 5 | 상한 1 → 두 태스크 | PASS — 두 번째가 대기열 레인 카드(`대기 1` pill + 세로 체인) → 슬롯이 나면 트리 행으로 승격 |
| 6 | `myapp 오류 나는 작업` | PASS — SessionEnd → error 노드·err 알림·채팅 `✖ … 재시작 버튼으로 --resume` → 재시작 → resume → done, err 알림 철회 |
| 7 | 팔레트 `kill` | PASS — ⌘⇧P → 전역 일시정지 → 배너 + 재개 버튼, 새 메시지는 `⏳ 접수`에서 대기 → 재개 → 그대로 디스패치 |
| 8 | 서버 재시작 | PASS(수정 후) — `연결 끊김 (마지막 seq 486)` → 재접속 → `이벤트 재생 중` → 정상, 태스크 목록 유지 |
| 9 | 휠 줌 후 새 태스크 | PASS — k=1.29·⤢ accent, 새 태스크가 와도 뷰 유지 → ⤢ 클릭으로 복귀 |
| 10 | 상세 details 펼침 + 1초 경과 | PASS — 1초 틱과 새 태스크로 인한 `refresh()` 양쪽 모두에서 펼침 유지 |
| 11 | 다크/라이트, 정렬 4종, 패널 토글 | PASS — 다크 토큰 전환, ⌘B/⌘J 토글, 정렬 4종 모두 레이아웃 깨짐 없음 |
| 12 | `상태?` | PASS — `gateway · fast-path` 배지 즉답, 게이트웨이 펄스 없음, 디스패치 로그 `fast-path · 즉답 (LLM 0회)` |
| 13 | 상세 "보관" | PASS — 2단계 확인(`보관 확인 (worktree 정리)`) → closed → 노드 제거·알림 철회·사이드바 회색 |
| 14 | 프로젝트 등록 폼 | PASS — 등록 → `projects.updated` 반영(키워드 파싱, 폼 초기화) → ✕ 삭제 반영 |
| 15 | 성능 예산 | PASS — 아래 표 |

Console stayed clean throughout: no uncaught errors and no unhandled rejections in any scenario.

### 15. 성능 실측 (2026-08-31, Apple Silicon, 1092×1110, 컴파일 바이너리)

`layout(); refresh()` 6회 중 첫 회(웜업) 제외 5회 평균. 합성 부하 = 상한 25%가 서브에이전트.

| 노드 | 평균 | 개별 | 예산 | 2026-08-30 데모 실측 |
|---|---|---|---|---|
| 20 | 2.12 ms | 2.6 / 2.0 / 1.9 / 2.4 / 1.7 | — | 3.4 ms |
| **60** | **6.82 ms** | 7.2 / 6.7 / 7.8 / 5.8 / 6.6 | **≤ 10 ms** | 7.7 ms |
| 150 | 15.40 ms | 14.1 / 16.1 / 16.1 / 16.1 / 14.6 | — | 20 ms |
| **300** | **37.54 ms** | 36.5 / 33.6 / 47.2 / 35.2 / 35.2 | **≤ 60 ms** | 42.5 ms |

v1 상한(동시 10, 화면 ≤ 60 노드)에서 한 프레임 예산 16 ms의 절반 이하다. 렌더는 이벤트 구동이고
rAF로 합쳐 한 프레임에 `relayout()` 1회만 부르므로, 훅이 몰려도 렌더는 프레임당 1회다.
300 노드 급으로 커지면 `renderNodes`를 노드별 diff로 바꾼다(`ponytail:`).

측정 시 탭은 `document.visibilityState === "hidden"`이었다(MCP 탭 그룹). 측정 구간은 동기 DOM 작업과
강제 리플로우(`renderEdges`/`updateMinimap`의 `offsetLeft` 읽기)뿐이고 페인트/합성은 어느 쪽에서도
구간 밖이라 값은 그대로 유효하다.

### 임베드 빌드

`bun run build:web && bun build --compile src/main.ts --outfile relay-bin` → 59 MB 바이너리.
`relay-bin serve`가 임베드된 대시보드를 그대로 서빙한다(104 KB, 외부 참조 0, `<title>relay</title>`).

## QA에서 고친 것

- **디스패처 배지 중복** — 서버는 판단 결과를 user 메시지의 `dispatch_json`(어댑터가 배지 칩으로 렌더)과
  `dispatcher · …` system 채팅 행으로 두 번 말한다. 텍스트 행을 버린다(`isDispatcherBadgeRow`).
- **타임라인 노이즈** — 상세 조회(`GET /api/tasks/:uuid`)는 태스크의 이벤트 로그 전체를 준다. 한 태스크에
  `task.patched` 119건 대 hook 110건이었고, `command.*`/`permit.*`/`process.*`까지 섞여 있었다. 라이브
  스트림과 같은 기준(`hook.*`/`send.outcome`/`message.sent`)으로 양쪽을 거른다(`isTimelineEvent`).
- **재접속 후 `이벤트 재생 중` 고착** — 모든 seq가 프레임을 내지는 않는다. 기동 때마다 나오는
  `system.recovered`는 프레임이 0개라 커서가 `as_of_seq`에 영원히 못 닿고 배너가 남았다. 서버가 약속하는
  `as_of_seq`를 **이벤트 커서가 아니라 프레임 커서**(`max(ws_frames.seq)`)로 바꿔 도달 가능하게 만들었다 —
  `hello`와 스냅숏 양쪽. 클라이언트는 타이머 없이 정확히 그 지점에서 배너를 지운다.

## 남은 관찰

- 대기열 카드 본문이 비어 있다 — 서버가 queued 태스크에 `last_step: null`을 주고, 데모는 "슬롯 대기 중
  (n/m 사용)"을 보여줬다. `대기 n` pill이 상태를 말하므로 v1은 이대로 둔다.
- 보관 후에도 그 태스크가 선택된 채로 상세에 남는다(데모는 `S.sel`을 비웠다). 사이드바가 closed 태스크를
  계속 보여주므로 선택 상태 자체는 유효하다.
- 토스트 스택이 캔버스 우상단 줌 버튼(+/−)을 5초간 가린다.
