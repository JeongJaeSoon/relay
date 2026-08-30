import { describe, expect, test } from "bun:test";
import { parseConfig } from "../../src/config.ts";

describe("config", () => {
  test("defaults", () => {
    const c = parseConfig("");
    expect(c.port).toBe(8790); expect(c.max_concurrent_agents).toBe(10);
    expect(c.dispatcher.model).toBe("claude-fable-5"); expect(c.worker.effort.normal).toBe("xhigh");
    expect(c.idle.stop_after_min).toBe(15); expect(c.usage.wall_clock_min.epic).toBe(480);
  });
  test("toml overrides + validation", () => {
    const c = parseConfig('port = 9000\n[dispatcher]\nmodel = "claude-opus-5"\neffort = "low"\n');
    expect(c.port).toBe(9000); expect(c.dispatcher.effort).toBe("low");
    expect(() => parseConfig("max_concurrent_agents = 0")).toThrow();
  });
});
