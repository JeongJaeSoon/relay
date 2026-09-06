import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFrame, loadPeerFixture } from "../../../src/runner/peer.ts";

test("embedded peer protocol loads outside a source checkout", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "relay-protocol-"));
  try {
    const module = join(import.meta.dir, "../../../src/runner/peer.ts");
    const env: Record<string, string | undefined> = { ...process.env, RELAY_HOME: scratch };
    delete env.RELAY_PEER_FIXTURE;
    const child = Bun.spawn([process.execPath, "-e", `import {loadPeerFixture,buildFrame} from ${JSON.stringify(module)};
      console.log(JSON.stringify(buildFrame(loadPeerFixture(),{msgId:'test',text:'hello',fromSocket:'/tmp/synthetic.sock',fromName:'relay',fromSession:'session'})));`], {
      cwd: scratch, env, stdout: "pipe", stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(error).toBe(""); expect(code).toBe(0);
    const frame = JSON.parse(output);
    expect(Object.keys(frame).sort()).toEqual(["from", "message", "msgV", "msg_id", "priority", "type"]);
    expect(frame.message.content).toContain("hello"); expect(frame.msg_id).toBe("test");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("explicit protocol overrides are honored and invalid ones fail visibly", () => {
  const scratch = mkdtempSync(join(tmpdir(), "relay-protocol-"));
  try {
    const file = join(scratch, "protocol.json");
    writeFileSync(file, JSON.stringify({ inbound: [{ lines: [{ type: "peer_message", text: "", msg_id: "" }] }] }));
    const frame = buildFrame(loadPeerFixture(file)!, { msgId: "m", text: "override", fromSocket: "s", fromName: "r", fromSession: "x" });
    expect(frame.text).toBe("override");
    writeFileSync(file, "{}"); expect(() => loadPeerFixture(file)).toThrow("no outbound frame");
    expect(() => loadPeerFixture(join(scratch, "missing.json"))).toThrow("does not exist");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
