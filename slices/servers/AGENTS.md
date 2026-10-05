# AGENTS.md — slices/servers

The **servers** this install knows about. Rust-only, no `-core`.

## Package roles

- **`servers-rust`** — `ServerRecord`, one server as the install stores it,
  and the `ServerRegistry` port over the list of them, with its
  `JsonServerRegistry` adapter at `<data root>/servers.json`.
  - Layout: `domain/` the record (`ServerRecord`, `Relay`, `TunnelToken`) and
    `RegistryError`; `ports/` the `ServerRegistry` port (read all, insert,
    update, remove); `adapters/` `JsonServerRegistry`.

## Rules

- **A server's domain is its identity.** `ServerRecord::domain()` is
  `<tunnel name>.<relay domain>`, the relay domain being the `domain` its
  `GET /rathole` returned. There's no separate display name; the registry is
  keyed by the domain, and each server's data folder is
  `<data root>/servers/<domain>/`.
- **The tunnel name is one DNS label.** `ServerRecord::tunnel_name` is a
  `TunnelName` from `rathole-settings-rust`, the same check the relay applies
  to its tunnels: one lowercase DNS label, never `admin`. It is checked on
  construction and again when `servers.json` is read.
- **`public_settings` is the only copy of the relay's dial settings.** The
  rathole client always dials the `remote_addr` and `public_key` the relay's
  `GET /rathole` returned. `Relay::Custom` holds only the relay's `base_url`.
- **A new server launches from `ServerRecord::DEFAULT_LAUNCHER_URL`**,
  `https://wildflowerhealth.io/app`.
- **The token is a secret.** `TunnelToken`'s `Debug` and `Serialize` write
  `<redacted>`, and it has no `Deserialize`. `JsonServerRegistry`'s own file
  representation is the only place the token is written in full, and the file
  is created readable by its owner only.
- **Configuration only.** Whether a server is running, its tunnel's liveness
  and its certificate are live state, held by whatever runs the server, never
  in a `ServerRecord`.
- **`servers.json` is versioned.** The file is
  `{"version": 1, "servers": [...]}`. A version this build doesn't read is
  `RegistryError::UnsupportedVersion`, and the file is neither read nor
  overwritten. A change to the stored shape bumps the version.
- **Writes are atomic.** Every change writes the whole document to
  `.servers.json.tmp` beside the file, fsyncs it, renames it over
  `servers.json` and fsyncs the directory, so a crash leaves either the old
  file or the new one.
- **No `tauri` dependency**, so the crate builds and tests in the non-Tauri
  partition of `scripts/checks/rust.sh`.

## References

- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
- `slices/tunnel/rathole-settings-rust` — `PublicRatholeSettings`, the
  `GET /rathole` response a record keeps as `public_settings`, and
  `TunnelName`.
