# Relay Explanation

A Wildflower server runs on a phone or laptop with no public address. Apps on
the web reach it through a relay: a machine with a public address that the
device keeps a tunnel open to. This doc is about what that relay is trusted
with, which is as little as we could make it: it routes encrypted connections
and never decrypts them.

## The path of a visitor's connection

```text
browser / app ──TLS──► relay :443 ── reads the ClientHello's SNI only
                          │
                          │ rathole control channel (noise)
                          ▼
            device: tunnel listener ── PROXY v2 header (optional)
                                    ── TLS, device-held certificate
                                    ── router
```

1. The visitor opens TLS to `https://<tunnel name>.<relay domain>`. DNS sends
   it to the relay.
2. The relay reads the server name (SNI) from the TLS ClientHello, and nothing
   else. It maps the name to the device's tunnel and hands the connection,
   hello included, to rathole, which carries it to the device over the
   device's noise-encrypted control channel. A relay that knows the visitor's
   address puts it in a PROXY protocol v2 header ahead of the hello.
3. On the device, the tunnel listener reads the PROXY header if there is one,
   terminates TLS with the certificate the device holds for its domain, and
   hands the request to the server's router. The device orders that
   certificate from Let's Encrypt over TLS-ALPN-01, whose validation
   handshakes arrive through the relay like any other visitor.

The [Origins Explanation](../Origins/Explanation.md#two-listeners) covers the
tunnel listener, and how its tunnel front writes `Forwarded` for the rest of
the server.

## What the operator can see

Whoever runs the relay sees routing metadata:

- **The hostname of each connection.** SNI is cleartext, so the relay sees
  which server every connection is for.
- **Visitors' IP addresses, and the timing and volume of their connections.**
  wildflower-relay doesn't log visitor addresses or byte counts, but it
  handles both, and a modified relay could record them.
- **When each device is online.** wildflower-relay logs each tunnel going up
  and down, and the rathole library logs the IP address each device's control
  channel comes from.
- **Each tunnel's name, token and owner's email.** The relay keeps them in its
  SQLite database, the token in plain text because rathole and request
  signing both need it. The email is whatever the operator recorded when
  creating the tunnel.

Holding the token, the operator can impersonate the device's tunnel to
rathole. Without a certificate for the device's domain, visitors' TLS still
fails.

## What the operator can't see

Request paths, headers, bodies, bearer tokens and FHIR resources. TLS
terminates on the device, and the relay never holds a key for a tunnel's
hostname; the only certificate it has is for its own hostnames. When a
connection names a tunnel the relay doesn't know, or one whose device is
offline, the relay closes it without presenting any certificate.

## The limit: the operator controls DNS

The operator controls DNS for the relay's domain, so it can get a certificate
for any device's hostname and sit in the middle of that device's connections,
decrypting and re-encrypting them. Passive reading is impossible; active
interposition is possible, but only for the operator, and it leaves a public
record. Every publicly trusted certificate is logged in Certificate
Transparency (CT) logs, so an interposing operator's certificate appears there
alongside the device's own.

The official relay's zone publishes a CAA record limiting issuance to Let's
Encrypt over TLS-ALPN-01:

```text
relay.wildflowerhealth.io. CAA 0 issue "letsencrypt.org; validationmethods=tls-alpn-01"
```

A TLS-ALPN-01 challenge is answered on port 443 of the address the hostname
resolves to, the relay. That leaves two parties who can get a certificate for
a device's hostname: the device, which answers through its tunnel, and the
operator, who holds the relay's port 443 and the DNS, and can change the
record. The device doesn't watch CT logs for unexpected certificates yet
(#898).

## What Let's Encrypt and the CT logs learn

Every certificate the device orders names its domain, `<tunnel name>.<relay
domain>`, and the CT logs publish it with the issuance time, permanently. So a
tunnel name should be meaningless: names the relay generates are pairs of
words from the EFF short wordlist, never anything taken from the owner's
email, and the Add server wizard warns that the address becomes public.

## The request log's visitor address

The request log records each tunnel request's visitor address (see the
[Server Runs Explanation](../../apps/host/servers/docs/Server%20Runs%20Explanation.md)).
That address comes from the PROXY v2 header:

- **wildflower-relay** writes the header for every connection, with the
  address it accepted the connection from. A visitor can't add their own:
  the relay expects a ClientHello and refuses anything else.
- **A stock rathole server** writes no header, so the address is absent. But
  rathole passes the visitor's bytes through untouched, so a visitor can send
  their own PROXY header and set any address they like.

So the address is only trustworthy behind wildflower-relay, and only as far as
you trust its operator, who writes the header. Nothing in the server grants
access on it.

## Leaving

Since the device holds the certificate, any relay that forwards TCP will do.
For one device, a stock rathole server is enough; for many devices under one
domain, run wildflower-relay yourself:

- [Stock Rathole Server How-To](./Stock%20Rathole%20Server%20How-To.md)
- [Deploying How-To](../../apps/relay/docs/Deploying%20How-To.md) —
  wildflower-relay

Either way, the operator is you.
