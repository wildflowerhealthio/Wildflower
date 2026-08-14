// Named imports, not the whole document: only these two fields concern this
// console, and importing them individually keeps the rest of the host's
// configuration out of a published bundle.
import {
  loopback_hostname as loopbackHostname,
  loopback_port as loopbackPort,
} from '../../wildflower-tauri/tauri-shared-config.json'

/**
 * Facts about a Wildflower host that this console needs, read from the same
 * `tauri-shared-config.json` the Rust host and the Tauri webview derive theirs
 * from — imported as a module and inlined at build time, so the console cannot
 * carry a stale copy of the loopback origin.
 */

/**
 * The loopback origin a desktop host's embedded API server binds, e.g.
 * `http://127.0.0.1:8080`. The console's target when no `?server=` is given.
 */
export const HOST_LOOPBACK_ORIGIN = `http://${loopbackHostname}:${loopbackPort}`
