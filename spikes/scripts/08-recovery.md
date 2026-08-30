# ⑧ Restart recovery — observation checklist

**Question:** after relay (the hook receiver) goes down for ~30s and comes back, can it rebuild
`process_state` for every task from `claude agents --json --all` alone, and does the spool preserve the
hooks that fired while it was down?

**Procedure**

1. `bun spikes/scripts/sandbox.ts`
2. Start the receiver on 8799 with the spool in front of it, i.e. inject `--settings` whose hooks are
   `command` hooks running `bun spikes/scripts/hook-spool.ts <Event> <spoolDir> http://127.0.0.1:8799/hook`
   (so a POST that fails leaves a file behind), and start the receiver:
   `bun spikes/scripts/hookd.ts 8799 spikes/results/08-recovery.jsonl`
3. Bring five `relay-spike:rec-*` workers into the five states below.
4. Kill the receiver, wait 30s (keep the workers working), restart it.
5. `claude agents --json --all > spikes/fixtures/agents-json-recovery.json`, count the spool files,
   then try to re-control each worker (`claude stop` / `claude --bg --resume <uuid> "…"`).
6. `bun -e 'import("./spikes/scripts/lib.ts").then(m=>m.record({recovery:{…}}))'`

**Fill in from the run**

| state | hooks spooled while down | after recovery: `agents --json` state / status / pid | re-controllable? (stop/resume) | notes |
|---|---|---|---|---|
| running (`sleep 120`) | | | | |
| idle (replied, waiting) | | | | |
| stopped (`claude stop`) | | | | |
| waiting (RELAY: question) | | | | |
| attached (user ran `claude attach`) | | | | |
| idle 65 min, untouched (optional) | — | does the supervisor stop it after ~1h (`state`, pid)? | resume? | C1: relay's own 15-min idle stop must always fire first |

**What the answers change**

- If `agents --json --all` alone cannot separate *stopped* from *crashed*, `src/lifecycle/recovery.ts`
  must also read `~/.claude/jobs/<short>/state.json` (measured in ①: it carries `state`, `sessionId`,
  `worktreePath`, `respawnFlags`) as the secondary source.
- Every hook that fired while the receiver was down must be replayable from the spool, or `⑥`'s
  design is not sufficient and `hook_inbox` has to become the primary durable store.

**Status: BLOCKED (not run).** The attached row needs an interactive `claude attach` in a real
terminal, and the whole checklist keeps five live sessions alive for several minutes. Run it manually
with the steps above.
