# Assembly

The layers before this one are written against traits: the domain against the store port, the capabilities against any `GrantStore`, the routes against `Live…` names. **Assembly is where the concrete pieces are chosen and the server is handed to the host**: the SQLite store, the shared revocation store, the host's configuration and its say over who may start requests. Nothing here decides what anyone may do. It decides what each rule is built from.

[Setup](<Assembly/Setup Explanation.md>) is the one call the host makes at boot, `setup_authorization_server`, and what it takes and gives back: the configuration, the constants naming the server's own clients and the Owner's authority, the background sweeps it starts, and what the crate root re-exports for the host.

[Live Bindings](<Assembly/Live Bindings Explanation.md>) is the shared state every request is served from, and the rule that binds a generic capability to the concrete store: each binding lifts only the handles its capability needs out of that state.

[Access Bindings](<Assembly/Access Bindings Explanation.md>) are the Owner's `/authorization` capabilities, one per resource and permission, each behind the scope its extractor checks before the capability exists.

[OAuth Bindings](<Assembly/OAuth Bindings Explanation.md>) are the `/oauth` front door's capabilities, which no token unlocks, and three in-process handles for the host: the launch minter, the sign-in code minter and the pending-consent watcher.

[Session Bindings](<Assembly/Session Bindings Explanation.md>) are the capabilities about the caller's own token: the token verifier every gate runs, and hands to the host's FHIR server, and the self-service reads and revokes that need a token but no scope.

[Ports and Adapters](<Assembly/Ports and Adapters Explanation.md>) are what the domain needs from outside the store, notifying the host of a pending consent, revoking and checking tokens, and asking whether a request may start, and what implements each.

[Seeding](<Assembly/Seeding Explanation.md>) is what exists at boot and why: the signing key, the server's own clients, and in debug builds the first-party apps' dev clients.
