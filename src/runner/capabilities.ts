import { existsSync, readFileSync } from "node:fs";
import type { DeliveryMethod } from "@shared/types.ts";
import { paths } from "../config.ts";

export interface Capabilities { delivery: DeliveryMethod; cli_version: string; bgResume?: string; agentsJsonVocab?: unknown; peerRegistration?: boolean; socketAuthLine?: string; advisorFlag?: boolean; permit?: { preToolUseDenyWorks?: boolean } }

export function loadCapabilities(path = paths.capabilities): Capabilities {
  if (!existsSync(path)) return { delivery: "resume", cli_version: "unknown" };
  const j = JSON.parse(readFileSync(path, "utf8"));
  const delivery: DeliveryMethod = j.delivery === "socket" ? "socket" : "resume";   // `--bg --resume` is a Phase 0 go/no-go; there is no print fallback (roadmap C9)
  return { ...j, delivery };
}
