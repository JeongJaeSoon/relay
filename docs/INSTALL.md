# relay 설치 · 운영 가이드

macOS + Homebrew 전용. Claude Code CLI 2.1.251 이상이 구독 계정으로 로그인돼 있어야 한다
(`ANTHROPIC_API_KEY`는 쓰지 않으며, relay는 서비스 환경에서 이를 제거한다).

## 1. 설치

```sh
brew install jeongjaesoon/tap/relay
```

formula가 `~/Library/Logs/relay/`를 만들고(`post_install`), `relay` 바이너리 하나를 설치한다.
대시보드 HTML과 에이전트 정의(`relay-worker/explore/verify.md`)는 바이너리에 임베드돼 있다.

## 2. 최초 설정

```sh
relay setup --service
```

단계:

1. `claude` 탐색 → `claude_bin`(절대 경로)과 `path_prepend`(claude 디렉토리 + node 디렉토리)를
   기록한다. launchd의 PATH에는 brew/npm bin이 없고, npm 설치본 `claude`는 `node`가 필요하다.
   버전(≥ 2.1.251)과 로그인(`claude -p ... --tools "" --output-format json`)을 확인한다.
2. `ANTHROPIC_API_KEY`가 설정돼 있으면 경고한다(서비스에서는 제거됨).
3. **서비스 컨텍스트 인증**: 일회용 launchd user agent로 같은 로그인 프로브를 돌려 Keychain이
   읽히는지 본다. 실패하면 아래 4절의 토큰 폴백을 안내한다.
4. `~/.config/relay/config.toml`(0600) 생성 — 포트·동시 실행 상한을 묻고 나머지는 기본값.
5. 프로젝트 등록 루프(경로 → 이름 → 설명 → 키워드). 서버가 떠 있으면 `POST /api/projects`로,
   꺼져 있으면 DB에 `project.registered`를 직접 기록한다.
6. `~/.claude/agents/relay-*.md` 설치. 이미 있고 내용이 다르면 덮어쓸지 묻는다(`/agents`로 편집 가능).
7. `claude mcp add --scope user relay -- <relay 절대경로> mcp` 등록. 경로는 Cellar가 아닌 `opt`
   경로라 `brew upgrade` 후에도 유효하다.
8. `capabilities.json`이 없으면 `--bg spawn → stop → --bg --resume` 프로브(약 1분)를 돌려 만든다.

```sh
brew services start relay
relay open            # http://127.0.0.1:8790
```

## 3. 진단

```sh
relay doctor              # 사람이 읽는 요약, 실패 항목엔 해결 명령
relay doctor --json       # 스크립트용
relay doctor --service    # 같은 점검을 launchd 안에서 다시 실행해 [service] 접두로 병합
relay doctor --probe      # CLI capability 재검사 → capabilities.json 갱신
```

`--service`가 중요한 이유: PATH와 Keychain 문제는 로그인 셸에서는 보이지 않고 서비스
컨텍스트에서만 드러난다. `claude 슈퍼바이저` 항목은 정보성이다 — 미실행이 정상이고 첫 `--bg`
때 자동으로 뜬다.

## 4. 서비스 컨텍스트 인증이 실패할 때(토큰 폴백)

launchd 아래에서 Keychain을 못 읽으면:

```sh
claude setup-token                 # 장기 OAuth 토큰 발급
relay setup --service              # 프롬프트에 붙여넣기 → ~/.config/relay/token (0600)
brew services restart relay
relay doctor --service             # [service] Keychain 인증 항목이 "토큰 파일 폴백"으로 ✔
```

## 5. 업데이트

```sh
brew upgrade relay
brew services restart relay
```

- DB 마이그레이션은 기동 때 자동으로 돌고, 스키마가 올라가면 먼저 `relay.db.bak-<from>`을 만든다
  (`db ready {from, to}` 로그). 마이그레이션이 실패하면 그 백업으로 되돌리고 기동을 멈춘다.
- 훅 명령과 MCP 등록은 Cellar가 아닌 `opt` 경로를 가리키므로 업그레이드 후에도 그대로 동작한다.
  `relay doctor`의 `MCP relay 등록` 항목이 등록된 명령 경로가 실제로 존재하는지까지 본다.

## 6. 백업 · 복원 · 정리

```sh
relay db backup                    # ~/.config/relay/relay.db.bak-<ISO> (vacuum into: 서버가 떠 있어도 일관 스냅숏)
relay db backup /path/to/file.db
brew services stop relay
relay db restore /path/to/file.db  # 현재 DB는 .pre-restore-<ISO>로 보관
brew services start relay
```

- `relay db sweep` — 90일 넘게 닫혀 있는 태스크의 이벤트·blob·ws_frame 삭제(태스크 행과 요약은
  유지). 서버가 하루 한 번 자동으로 돌리며, 마지막 VACUUM이 30일 지났으면 VACUUM까지 한다.
- `relay db rebuild` — 이벤트 로그에서 프로젝션 전체를 재생(서버가 실행 중이면 거부). 로그가
  정본이고 `tasks`/`messages`/`commands`는 캐시다.

## 7. 서비스 기동 실패 플래그

`serve()`는 `RELAY_SERVICE=1`에서 기동에 실패하면 `~/.config/relay/service-failed`에 자신의
버전을 쓰고 exit 78로 죽는다. 다음 기동에서 플래그의 버전이 자신과 같으면 exit 0으로 잠든다 —
formula가 `keep_alive successful_exit: false`라 성공 종료에는 재시작하지 않으므로 10초 간격
무한 재시작이 생기지 않는다. `brew upgrade`로 버전이 바뀌면 자동으로 다시 시도한다.

```sh
tail -50 ~/Library/Logs/relay/stderr.log
rm ~/.config/relay/service-failed && brew services restart relay
```

## 8. 제거

```sh
brew services stop relay
brew uninstall relay
claude mcp remove --scope user relay
rm -rf ~/.config/relay ~/Library/Logs/relay ~/.claude/agents/relay-*.md
```

## 9. 릴리스(메인테이너)

```sh
sh scripts/release.sh 0.1.1
```

`package.json` 버전을 올리고 `scripts/compile.sh`로 arm64/x64 바이너리·tarball·`SHA256SUMS`를
만든 뒤, tap 저장소의 `Formula/relay.rb`에 버전과 sha256을 채워 넣는다. git/GitHub 쓰기는
**하지 않는다** — 스크립트가 마지막에 출력하는 커밋·태그·`gh release create`·tap 푸시 절차를
사람이 실행한다.
