// Module entry: app.js (classic script, evaluated first) owns the DOM; we own server state and bind the two.
import { installAdapter } from "./adapter.ts";
import { connect } from "./ws.ts";
installAdapter();
connect();
