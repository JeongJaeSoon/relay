import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setNow } from "../src/core/clock.ts";
setNow(null);
// Keep tests out of the real ~/.config/relay and ~/Library/Logs/relay: modules resolve `paths` lazily from RELAY_HOME.
process.env.RELAY_HOME ??= mkdtempSync(join(tmpdir(), "relay-test-"));
process.env.RELAY_LOG_DIR ??= process.env.RELAY_HOME;
process.env.RELAY_NO_FILE_LOG ??= "1";
