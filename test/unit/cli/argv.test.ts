import { describe, expect, test } from "bun:test";
import { KNOWN, planArgv } from "../../../src/cli/argv.ts";
const kind = (...argv: string[]) => planArgv(argv).kind;
const reason = (...argv: string[]) => { const p = planArgv(argv); return p.kind === "usage" ? p.reason : `(not usage: ${p.kind})`; };
describe("planArgv", () => {
  test("bare relay and help print usage, never a dispatch", () => {                     // C29: booting a server (or sending a message) is not what someone typing the bare name asked for
    expect(kind()).toBe("help"); expect(kind("help")).toBe("help"); expect(kind("--help")).toBe("help");
  });
  test("known subcommands win over prose, with their flags and arguments intact", () => {
    expect(planArgv(["ls", "--all"])).toEqual({ kind: "command", cmd: "ls", rest: ["--all"] });
    expect(planArgv(["send", "hello", "--to", "T-08"])).toEqual({ kind: "command", cmd: "send", rest: ["hello", "--to", "T-08"] });
    for (const c of ["ls", "open", "pause", "resume-all", "setup", "doctor", "mcp", "--version", "-v"]) expect(kind(c)).toBe("command");
    for (const c of [["tail", "T-08"], ["attach", "T-08"], ["db", "backup", "/tmp/x"]]) expect(kind(...c)).toBe("command");
  });
  test("a command that takes no arguments refuses prose instead of running", () => {    // `relay pause the login task` tripped the kill switch and exited 0
    for (const a of [["pause", "the", "login", "task"], ["open", "the", "auth", "module"], ["setup", "the", "new", "project"], ["help", "me", "debug", "the", "parser"], ["ls", "the", "tasks"]]) expect(kind(...a)).toBe("usage");
    expect(reason("pause", "the", "login", "task")).toBe('relay: pause takes no arguments — to send this as a message: relay send "pause the login task"');
  });
  test("quoted prose is a message — the shell hands it over as one token", () => {
    expect(planArgv(["refactor the auth module"])).toEqual({ kind: "message", argv: ["refactor the auth module"] });
    expect(planArgv(["fix the parser", "--to", "T-08"])).toEqual({ kind: "message", argv: ["fix the parser", "--to", "T-08"] });
    expect(kind("pause the login task")).toBe("message");                               // quoting is the explicit "this is prose" signal
  });
  test("a bare ASCII word is a mistyped subcommand, arguments or not", () => {          // guessing wrong costs a real dispatch, maybe a spawned task; being told to quote costs a retype
    for (const a of [["lst"], ["lst", "--json"], ["resume", "all"], ["tial", "T-08"], ["atach", "T-08"], ["sedn", "fix the parser"], ["refactor", "the", "auth", "module"]]) expect(kind(...a)).toBe("usage");
    expect(reason("resume", "all", "--to", "T-08")).toBe('relay: "resume" looks like a command — to send it as a message: relay send "resume all" --to T-08');
  });
  test("a token no subcommand could be is prose, however short", () => {                // word counting only ever worked for space-delimited languages
    for (const a of ["認証まわりを直して", "把认证模块重构一下", "배포해줘", "재시작", "상태?", "fix(parser):", "3 tasks are stuck"]) expect(kind(a)).toBe("message");
    expect(planArgv(["--to", "T-08", "재시작"])).toEqual({ kind: "message", argv: ["--to", "T-08", "재시작"] });   // the head is the first positional, not the first token
  });
  test("a leading dash with nothing to send is an unknown option", () => { expect(reason("--jsonn")).toBe('relay: unknown option "--jsonn"'); });
  test("every known command is command-shaped — the shape rule rests on it", () => {
    for (const c of KNOWN) expect(c.replace(/^-+/, "")).toMatch(/^[A-Za-z][A-Za-z-]*$/);
  });
});
