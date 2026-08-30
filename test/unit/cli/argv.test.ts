import { describe, expect, test } from "bun:test";
import { planArgv } from "../../../src/cli/argv.ts";
const kind = (...argv: string[]) => planArgv(argv).kind;
describe("planArgv", () => {
  test("bare relay and help print usage, never a dispatch", () => {                     // C29: booting a server (or sending a message) is not what someone typing the bare name asked for
    expect(kind()).toBe("help"); expect(kind("help")).toBe("help"); expect(kind("--help")).toBe("help");
  });
  test("known subcommands win over prose, with their flags intact", () => {
    expect(planArgv(["ls", "--all"])).toEqual({ kind: "command", cmd: "ls", rest: ["--all"] });
    expect(planArgv(["send", "hello", "--to", "T-08"])).toEqual({ kind: "command", cmd: "send", rest: ["hello", "--to", "T-08"] });
    for (const c of ["ls", "tail", "open", "attach", "pause", "resume-all", "setup", "doctor", "db", "mcp", "--version", "-v"]) expect(kind(c)).toBe("command");
  });
  test("a quoted sentence is a message — the shell hands it over as one token", () => {
    expect(planArgv(["refactor the auth module"])).toEqual({ kind: "message", argv: ["refactor the auth module"] });
    expect(kind("refactor", "the", "auth", "module")).toBe("message");
    expect(kind("한글도 그대로 보낸다")).toBe("message");
  });
  test("flags ride along like send's do", () => {
    expect(planArgv(["fix the parser", "--to", "T-08"])).toEqual({ kind: "message", argv: ["fix the parser", "--to", "T-08"] });
    expect(kind("fix", "the", "parser", "--to", "T-08")).toBe("message");
  });
  test("a one-word token is a mistyped subcommand, not prose — flags do not make it prose", () => {   // a wrong guess here costs a real dispatch, maybe a spawned task
    expect(planArgv(["lst"])).toEqual({ kind: "unknown", token: "lst" });
    expect(kind("lst", "--json")).toBe("unknown");
    expect(kind("lst", "--to", "T-08")).toBe("unknown");
    expect(kind("상태?")).toBe("unknown");
  });
  test("a leading dash is never prose", () => { expect(planArgv(["--jsonn"])).toEqual({ kind: "unknown", token: "--jsonn" }); });
  test("an exact subcommand only matches the whole first token", () => {
    expect(kind("open")).toBe("command"); expect(kind("open the auth module")).toBe("message");
  });
});
