# Deploying How-To

Run wildflower-relay (`wildflowerhealthio-relay-server`) for many devices
under one domain: each device gets a tunnel, reached at
`<tunnel name>.<domain>`. For one device, a stock rathole server is simpler
(see the [Stock Rathole Server How-To](../../../docs/Relay/Stock%20Rathole%20Server%20How-To.md)).
For what the relay can and can't see, see the
[Relay Explanation](../../../docs/Relay/Explanation.md).

The relay owns public ports 443 and 80 and needs raw TCP, so it runs alone on
its host, not behind another proxy. The crate docs in
[`relay-server/src/lib.rs`](../relay-server/src/lib.rs) describe how it works.

## 1. DNS

For a relay at `relay.example.com`:

| Record                | Points at  | Why                                                                                  |
| --------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `relay.example.com`   | relay host | The relay's own site and the control port devices dial. A wildcard doesn't cover it. |
| `*.relay.example.com` | relay host | Every tunnel, and `admin.relay.example.com`, the admin page.                         |

Restrict certificate issuance to Let's Encrypt over TLS-ALPN-01, which is how
both the relay and the devices validate:

```text
relay.example.com. CAA 0 issue "letsencrypt.org; validationmethods=tls-alpn-01"
```

## 2. Firewall

Open 443 (TLS, routed by server name), 80 (redirects to `https://`) and the
control port devices' rathole clients dial, 2333 by default.

## 3. Build

The binary embeds the admin page, so build that first:

```sh
vp install
vp run -F @wildflowerhealthio/relay-admin-web build
cargo build --release --locked -p wildflowerhealthio-relay-server
```

## 4. Install

Follow the steps in the header of
[`wildflowerhealthio-relay-server.service`](../relay-server/wildflowerhealthio-relay-server.service):
install the binary in `/opt/wildflower-relay`, the environment file in
`/etc/wildflower-relay/env`, and the unit. The unit runs the relay as an
unprivileged dynamic user allowed only to bind 443 and 80, with its state in
`/var/lib/wildflower-relay`.

The environment file is the relay's only configuration;
[`relay.example.env`](../relay-server/relay.example.env) lists every
variable. Set:

- `WILDFLOWER_RELAY_DOMAIN` — `relay.example.com`. Required.
- `WILDFLOWER_RELAY_NOISE_PRIVATE_KEY` — the private key from
  `rathole --genkey`. Required. The relay serves the matching public key to
  devices.
- `WILDFLOWER_RELAY_ADMIN_KEY` — at least 32 bytes, e.g.
  `openssl rand -base64 32`. Without it the admin API isn't served and no
  tunnel can be created.
- `WILDFLOWER_RELAY_ACME_STAGING=true` while trying out a new host: Let's
  Encrypt's staging certificates aren't browser-trusted, but its rate limits
  are much higher. Remove it once things work.

On its first start the relay orders the certificate for its own hostnames,
and `https://relay.example.com/health` answers once it is issued.

## 5. Create tunnels

1. Open `https://admin.relay.example.com/` and sign in by pasting the admin
   key. A `401` means the key is wrong or your clock is more than a minute off
   the relay's.
2. Create a tunnel with its owner's email. Leave the name empty: the relay
   picks two random words, since the name ends up in public CT logs.
3. Copy the token, which is shown once, and give the owner the tunnel name and
   token.

On the device, the owner chooses **Add new server**, then
**A self-hosted Wildflower relay**, enters `https://relay.example.com` as the
**Wildflower Relay URL**, and then the tunnel name and token.

## Let's Encrypt's rate limit

Every device's certificate is for a name under your domain, so all of them
share Let's Encrypt's limit of 50 new certificates per registered domain per 7
days. Renewals are exempt. A relay adding devices faster than that needs Let's
Encrypt's rate-limit adjustment.

## The official relay's deploy

The official relay deploys from
[`.github/workflows/deploy-relay.yml`](../../../.github/workflows/deploy-relay.yml)
on pushes to `main`. It builds as above, uploads the binary and environment
file over SSH, and runs [`deploy/install.sh`](../relay-server/deploy/install.sh),
which restarts the relay and rolls back if it doesn't come up healthy. The
host's `deploy` user may run only the root commands in
[`deploy/sudoers`](../relay-server/deploy/sudoers), and the unit is installed
by hand. Fork the workflow if you want the same for your own relay.
