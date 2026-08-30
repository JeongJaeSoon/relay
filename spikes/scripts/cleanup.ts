// spikes/scripts/cleanup.ts — remove every relay-spike:* session and its worktree.
import { spikeAgents, stopAndRm } from "./lib.ts";
for (const a of await spikeAgents(true)) { console.log("rm", a.id, a.name); await stopAndRm(a.id); }
