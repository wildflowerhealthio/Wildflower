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

## 3. Build and install

Follow the steps in the header of
[`wildflowerhealthio-relay-server.service`](../relay-server/wildflowerhealthio-relay-server.service):
build the admin page and the binary, install the binary in
`/opt/wildflower-relay`, the environment file in
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

## 4. Create tunnels

1. Open `https://admin.relay.example.com/` and sign in by pasting the admin
   key. A `401` means the key is wrong or your clock is more than a minute off
   the relay's.
2. Create a tunnel with its owner's email. Leave the name empty: the relay
   picks two random words, since the name ends up in public CT logs.
3. Choose **Issue claim code** on the tunnel's row, and give the owner the
   code it shows, eight characters such as `ABCD-EFGH`.

On the device, the owner chooses **Add new server**, then
**A self-hosted Wildflower relay**, enters `https://relay.example.com` as the
**Wildflower Relay URL**, and then the claim code. The app redeems it, once,
at `POST https://relay.example.com/claim` for the tunnel's name and token,
which it saves; the code itself is kept nowhere. A code redeems within ten
days (`WILDFLOWER_RELAY_CLAIM_CODE_TTL_SECS`), so it can be read out
instead of copied. Issue another if it expires: a tunnel has one outstanding
code, so issuing a new one cancels the earlier one. Guessing is rate limited,
per client address and across all clients.

The token the tunnel was created with, shown once, works too: under the
claim code field, **I have a tunnel name and full length token** takes the
tunnel name and token instead.

To let someone make their own tunnel instead, choose **Issue claim code**
under **Claim codes for new servers** and give them the code it shows. On the
device they enter it as any claim code; the relay answers that it names no
tunnel, so the app asks for their email and, optionally, a subdomain, then
redeems it, once, at `POST https://relay.example.com/claim` for a new tunnel
under them. Left empty, the relay picks the subdomain, as it does for a
tunnel created without a name. A taken or reserved subdomain, or an unusable
email, is refused without spending the code. These codes expire as a
tunnel's do, and any number can be outstanding. The new tunnel shows in the
list like any other.

If a token leaks, or the owner loses it, **Reissue token** on the tunnel's
row replaces it after a confirmation and shows the new one once. The old
token stops working at once, and the device using it disconnects until the
owner enters the new one. A claim code issued before the reissue redeems for
the new token.

## Logs

The relay writes two logs. `RUST_LOG` (default `info`) sets the level for
both.

- **The journal** (`journalctl -u wildflowerhealthio-relay-server`) carries no
  tunnel names, hostnames other than the relay's own, IP addresses, emails or
  claim codes. A connection refused because its tunnel's visitor queue
  stayed full, or because its PROXY header could not be built, is also a
  warning there, without the address or tunnel.
- **The connection log**, in `/var/lib/wildflower-relay/connection-log/`
  (`<state dir>/connection-log/`), holds the lines that name someone: tunnels
  going up and down, tunnels created, deleted or given a new token, claim
  codes issued and redeemed, every line from rathole, which names each
  device's IP address, and every refused `:443` connection. A refusal's
  line has the visitor's `ip:port`, the outcome (`unknown_tunnel`,
  `not_a_hello`, …), how long the connection lasted, and its detail: the
  tunnel or the server name asked for, the IP and the first few ALPN
  protocols (each cut to 16 bytes) a hello without a server name offered,
  the bytes received before the hello
  deadline, or the first 32 bytes, escaped, of a connection that wasn't a
  TLS ClientHello. It is one file per UTC hour, such as
  `connection.2026-10-16-13.log`, and the relay deletes each file 24 hours
  after its last entry. Successful connections aren't logged.

How many connections reached a device each hour, and how many were refused
and why, are on the admin page, kept for 30 days, with no tunnel names or
addresses. Each tunnel's row there says what became of its last connection
since the relay started.

## Let's Encrypt's rate limit

Every device's certificate is for a name under your registered domain
(`example.com` for a relay at `relay.example.com`), so all of them share Let's
Encrypt's limit of 50 new certificates per registered domain per 7 days, with
the relay's own certificate and any other name under that domain. Renewals are exempt. A relay adding devices faster than that needs Let's
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
