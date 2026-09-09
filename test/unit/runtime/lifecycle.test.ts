import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { parseConfig } from "../../../src/config.ts";
import { boot } from "../../../src/serve.ts";
import { installShutdownSignals, RuntimeLifecycle } from "../../../src/runtime/lifecycle.ts";
import { getMeta, setMeta } from "../../../src/db/db.ts";

test("runtime cleanup is reverse-order, failure-tolerant, and idempotent", () => {
  const calls: string[] = [];
  const runtime = new RuntimeLifecycle(() => calls.push("error"));
  runtime.add(() => calls.push("db"));
  runtime.add(() => { calls.push("http"); throw new Error("already closed"); });
  runtime.add(() => calls.push("timers"));
  runtime.stop(); runtime.stop();
  expect(calls).toEqual(["timers", "http", "error", "db"]);
});

test("signal handlers can be removed without exiting", () => {
  const source = new EventEmitter(); let stops = 0; const exits: number[] = [];
  const remove = installShutdownSignals(source, () => stops++, (code) => exits.push(code));
  source.emit("SIGTERM"); remove(); source.emit("SIGINT");
  expect(stops).toBe(1); expect(exits).toEqual([0]);
});

test("actual boot cleans HTTP, peer, and DB when recovery fails", async () => {
  const previousHome = process.env.RELAY_HOME;
  const previousLogDir = process.env.RELAY_LOG_DIR;
  const home = mkdtempSync(join(tmpdir(), "relay-boot-failure-"));
  process.env.RELAY_HOME = home; process.env.RELAY_LOG_DIR = home;
  writeFileSync(join(home, "capabilities.json"), JSON.stringify({ delivery: "socket", cli_version: "2.1.251" }));
  const calls: string[] = []; let capturedDb: any;
  try {
    await expect(boot(parseConfig("port = 18790"), {}, {
      currentCliVersion: async () => "2.1.251",
      createPeer: () => ({ socketPath: "/tmp/fake-relay-peer.sock", start: async () => { calls.push("peer.start"); }, stop: () => { calls.push("peer.stop"); } }),
      startServer: ((ctx: any) => { capturedDb = ctx.db; calls.push("http.start"); return { server: {} as any, stop: () => { calls.push("http.stop"); } }; }) as any,
      recover: (async () => { calls.push("recover"); throw new Error("injected recovery failure"); }) as any,
    })).rejects.toThrow("injected recovery failure");
    expect(calls).toEqual(["peer.start", "http.start", "recover", "http.stop", "peer.stop"]);
    expect(() => capturedDb.query("select 1").get()).toThrow();
  } finally {
    if (previousHome === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = previousHome;
    if (previousLogDir === undefined) delete process.env.RELAY_LOG_DIR; else process.env.RELAY_LOG_DIR = previousLogDir;
  }
});

test("actual boot retries an incomplete recovery without overlapping until the roster becomes available", async () => {
  const previousHome = process.env.RELAY_HOME; const home = mkdtempSync(join(tmpdir(), "relay-recovery-retry-")); process.env.RELAY_HOME = home;
  writeFileSync(join(home, "capabilities.json"), JSON.stringify({ delivery: "socket", cli_version: "2.1.251" }));
  let attempts = 0; let active = 0; let maxActive = 0; let capturedDb: any; let running: Awaited<ReturnType<typeof boot>> | null = null; const calls: string[] = [];
  try {
    running = await boot(parseConfig("port = 18794"), {}, {
      recoveryRetryMs: 5,
      currentCliVersion: async () => "2.1.251",
      createPeer: () => ({ socketPath: "/tmp/fake.sock", start: async () => {}, stop: () => { calls.push("peer.stop"); } }),
      startServer: ((ctx: any) => { capturedDb = ctx.db; return { server: {} as any, stop: () => { calls.push("http.stop"); } }; }) as any,
      recover: (async ({ db }: any) => {
        attempts++; active++; maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (attempts >= 2) setMeta(db, "recovering", "0");
        active--;
      }) as any,
    });
    for (let i = 0; i < 20 && getMeta(capturedDb, "recovering") !== "0"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(attempts).toBe(2); expect(maxActive).toBe(1); expect(getMeta(capturedDb, "recovering")).toBe("0");
    running.stop(); expect(calls).toEqual(["http.stop", "peer.stop"]); expect(() => capturedDb.query("select 1").get()).toThrow();
    running = null;
  } finally { running?.stop(); if (previousHome === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = previousHome; }
});

test("actual boot stops a peer whose startup fails", async () => {
  const previousHome = process.env.RELAY_HOME; const home = mkdtempSync(join(tmpdir(), "relay-peer-failure-")); process.env.RELAY_HOME = home;
  writeFileSync(join(home, "capabilities.json"), JSON.stringify({ delivery: "socket", cli_version: "2.1.251" }));
  const calls: string[] = [];
  try {
    await expect(boot(parseConfig("port = 18791"), {}, {
      currentCliVersion: async () => "2.1.251",
      createPeer: () => ({ socketPath: "/tmp/fake.sock", start: async () => { calls.push("peer.start"); throw new Error("peer failed"); }, stop: () => { calls.push("peer.stop"); } }),
      startServer: (() => { throw new Error("HTTP must not start"); }) as any,
      recover: (async () => {}) as any,
    })).rejects.toThrow("peer failed");
    expect(calls).toEqual(["peer.start", "peer.stop"]);
  } finally { if (previousHome === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = previousHome; }
});

test("actual boot closes peer and DB when HTTP startup fails", async () => {
  const previousHome = process.env.RELAY_HOME; const home = mkdtempSync(join(tmpdir(), "relay-http-failure-")); process.env.RELAY_HOME = home;
  writeFileSync(join(home, "capabilities.json"), JSON.stringify({ delivery: "socket", cli_version: "2.1.251" }));
  const calls: string[] = []; let capturedDb: any;
  try {
    await expect(boot(parseConfig("port = 18792"), {}, {
      currentCliVersion: async () => "2.1.251",
      createPeer: () => ({ socketPath: "/tmp/fake.sock", start: async () => { calls.push("peer.start"); }, stop: () => { calls.push("peer.stop"); } }),
      startServer: ((ctx: any) => { capturedDb = ctx.db; calls.push("http.start"); throw new Error("http failed"); }) as any,
      recover: (async () => {}) as any,
    })).rejects.toThrow("http failed");
    expect(calls).toEqual(["peer.start", "http.start", "peer.stop"]);
    expect(() => capturedDb.query("select 1").get()).toThrow();
  } finally { if (previousHome === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = previousHome; }
});

test("SIGTERM during held recovery cleans acquired resources before exit", async () => {
  const previousHome = process.env.RELAY_HOME; const home = mkdtempSync(join(tmpdir(), "relay-signal-recovery-")); process.env.RELAY_HOME = home;
  writeFileSync(join(home, "capabilities.json"), JSON.stringify({ delivery: "socket", cli_version: "2.1.251" }));
  const signals = new EventEmitter(); const calls: string[] = []; const exits: number[] = []; let capturedDb: any;
  let enterRecovery!: () => void; const entered = new Promise<void>((resolve) => { enterRecovery = resolve; });
  let failRecovery!: (error: Error) => void; const heldRecovery = new Promise<never>((_resolve, reject) => { failRecovery = reject; });
  try {
    const starting = boot(parseConfig("port = 18793"), {}, {
      signals,
      exit: (code) => { exits.push(code); },
      currentCliVersion: async () => "2.1.251",
      createPeer: () => ({ socketPath: "/tmp/fake.sock", start: async () => { calls.push("peer.start"); }, stop: () => { calls.push("peer.stop"); } }),
      startServer: ((ctx: any) => { capturedDb = ctx.db; calls.push("http.start"); return { server: {} as any, stop: () => { calls.push("http.stop"); } }; }) as any,
      recover: (async () => { calls.push("recover"); enterRecovery(); return heldRecovery; }) as any,
    });
    await entered;
    signals.emit("SIGTERM"); signals.emit("SIGINT");
    expect(exits).toEqual([0]);
    expect(calls).toEqual(["peer.start", "http.start", "recover", "http.stop", "peer.stop"]);
    expect(() => capturedDb.query("select 1").get()).toThrow();
    failRecovery(new Error("finish held recovery"));
    await expect(starting).rejects.toThrow("finish held recovery");
  } finally { if (previousHome === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = previousHome; }
});
