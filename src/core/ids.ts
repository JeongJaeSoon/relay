import { ulid as _ulid } from "ulid";
import { createHash } from "node:crypto";
export const ulid = () => _ulid();
export const taskUuid = () => crypto.randomUUID();
export const displayId = (num: number) => `T-${String(num).padStart(2, "0")}`;
/** Deterministic command id so a crash between decision and execution cannot double-apply. */
export const commandId = (kind: string, key: string) => `${kind}:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
export const short8 = (uuid: string) => uuid.replace(/-/g, "").slice(0, 8);
