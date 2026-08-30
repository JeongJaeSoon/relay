const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "anthropic"], [/gh[pous]_[A-Za-z0-9]{36}/g, "github"], [/AKIA[0-9A-Z]{16}/g, "aws"],
  [/Bearer [A-Za-z0-9._-]{20,}/g, "bearer"], [/-----BEGIN [A-Z ]*PRIVATE KEY-----[^"]*?-----END [A-Z ]*PRIVATE KEY-----/g, "privatekey"],
  [/CLAUDE_CODE_OAUTH_TOKEN=[^\s"\\]+/g, "oauth"],
];
// Patterns run over a serialized JSON document, so each must stay inside a single string value: `"` and `\` end one, and
// eating them splices neighbouring keys together (or leaves the document unparseable) instead of hiding a secret.
export function redact(s: string): string { return PATTERNS.reduce((acc, [re, kind]) => acc.replace(re, `[redacted:${kind}]`), s); }
export const PAYLOAD_CAP = 65_536;
/** Redact then cap. Oversized payloads are shrunk (strings, arrays and key counts) and flagged; the original is returned as `blob` for the blobs table. */
export function capPayload(payload: unknown): { json: string; truncated: boolean; blob?: string } {
  const full = redact(JSON.stringify(payload ?? null));
  if (full.length <= PAYLOAD_CAP) return { json: full, truncated: false };
  const shrink = (v: unknown, budget: number): unknown => {
    if (typeof v === "string") return v.length > budget ? v.slice(0, budget) + "…[truncated]" : v;
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => shrink(x, Math.max(256, Math.floor(budget / 4))));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 100).map(([k, x]) => [k, shrink(x, Math.max(256, Math.floor(budget / 4)))]));
    return v;
  };
  const safe = JSON.parse(full) as unknown;                                  // shrink the redacted value so no secret survives truncation
  let json = JSON.stringify({ ...(typeof safe === "object" && safe ? (shrink(safe, 8_000) as object) : { value: shrink(safe, 8_000) }), __truncated: true });
  if (json.length > PAYLOAD_CAP) json = JSON.stringify({ __truncated: true, preview: full.slice(0, 8_000) });   // pathological width: keep a preview only
  return { json, truncated: true, blob: full };
}
