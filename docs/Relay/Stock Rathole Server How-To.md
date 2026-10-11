# Stock Rathole Server How-To

Run your own relay for one device with an upstream
[rathole](https://github.com/rathole-org/rathole) server, no Wildflower code
on the server. For one device this is the simplest relay to run. For many
devices under one domain, deploy wildflower-relay instead (see the
[Deploying How-To](../../apps/relay/docs/Deploying%20How-To.md)). For what any
relay can and can't see, see the [Relay Explanation](./Explanation.md).

The device runs a rathole fork whose wire protocol is upstream's, so the
official v0.5.0 release and upstream `master` both work.

## 1. Get rathole and a key pair

Download a release binary from rathole's releases page; the release builds
include the noise transport. Then:

```sh
rathole --genkey
```

It prints a private key and a public key. The private key goes in the server's
config; the public key goes in Wildflower.

## 2. Configure the server

Pick a tunnel name, one lowercase DNS label (`a-z`, `0-9` and `-`), and a
random token, e.g. `openssl rand -base64 32`. The tunnel name is public (see
[What Let's Encrypt and the CT logs learn](./Explanation.md#what-lets-encrypt-and-the-ct-logs-learn)),
so make it meaningless.

`server.toml`:

```toml
[server]
bind_addr = "0.0.0.0:2333"

[server.transport]
type = "noise"

[server.transport.noise]
local_private_key = "<private key>"

[server.services.<tunnel name>]
token = "<token>"
bind_addr = "0.0.0.0:443"
```

- Leave the noise `pattern` at its default, `Noise_NK_25519_ChaChaPoly_BLAKE2s`:
  it is the only one the device runs.
- Binding 443 needs root or `CAP_NET_BIND_SERVICE`.
- Stock rathole has no routing by server name, so a host's port 443 serves one
  device.
- The default heartbeats are fine. Don't raise the server's
  `heartbeat_interval` above 40 seconds, the device's heartbeat timeout.

Run it with `rathole server.toml`.

## 3. DNS and firewall

The server's domain is always `<tunnel name>.<tunnel domain>`, where the
tunnel domain is any domain you control, e.g. `<tunnel name>.relay.example.com`.

- Give `<tunnel name>.<tunnel domain>` an A and/or AAAA record pointing at the
  rathole host.
- Open port 443 and the control port (2333 above). Port 80 isn't needed.
- Let's Encrypt validates the device's certificate over TLS-ALPN-01 on port
  443, which rathole passes through to the device, and the device answers it
  itself.
- Optionally, restrict issuance with a CAA record like the official relay's:

  ```text
  relay.example.com. CAA 0 issue "letsencrypt.org; validationmethods=tls-alpn-01"
  ```

## 4. Add the server in Wildflower

1. **Add new server**, then under **What kind of Relay are you using?** choose
   **A different reverse proxy**.
2. **Server address**: `<rathole host>:2333`.
3. **Public key**: the public key from `rathole --genkey`.
4. **Tunnel domain**: the domain after the tunnel name, e.g.
   `relay.example.com`.
5. Continue. **Tunnel name**: the service name from `server.toml`, exactly.
   **Tunnel token**: its token.

When the server starts, the device dials rathole, orders its certificate and
checks that `https://<tunnel name>.<tunnel domain>/health` answers.

## Troubleshooting

The rathole server's log says what went wrong:

| Server log                                 | Cause                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `Failed to do noise handshake`             | The **Public key** in Wildflower isn't the server's.                                                                  |
| `No such a service <hex>`                  | The **Tunnel name** doesn't match a `[server.services.<name>]`. The device sends the name as a digest, hence the hex. |
| `Service <name> failed the authentication` | The **Tunnel token** doesn't match the service's `token`.                                                             |

## Visitor addresses

Stock rathole writes no PROXY header, so the request log has no visitor
address, and a visitor can forge one by sending a PROXY header of their own.
See [The request log's visitor address](./Explanation.md#the-request-logs-visitor-address).
