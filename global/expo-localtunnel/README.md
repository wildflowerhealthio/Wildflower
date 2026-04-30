# expo-localtunnel

An Expo-compatible port of [localtunnel](https://github.com/localtunnel/localtunnel) for React Native. Establishes outbound TCP tunnels from a device to a relay (default `localtunnel.me`) so an on-device service is reachable from the public internet via a relay-assigned URL. Built for SMART-on-FHIR launch flows that need a public URL pointing at a service running on a real device, without requiring the device to be on the same network as a developer machine.

## Security model

Read this before using.

This package opens an unauthenticated tunnel from a public URL to a service on the device's loopback. **Anyone who reaches that URL can hit the local service.** The relay does not provide authentication, rate-limiting, or transport guarantees beyond what your local service implements.

- Use only with services you intentionally expose.
- Treat it as **development and test only** unless you understand the implications.
- Add authentication at the local service level (bearer tokens, mTLS, signed launch URLs, etc.) — do not assume the URL alone is private.
- For production-like environments, run your own relay and pass it via the `host` option instead of relying on the public `localtunnel.me` instance.

## Installation

This is a workspace package in the wildflower monorepo. Add it as a dependency from another workspace package:

```jsonc
// package.json
{
  "dependencies": {
    "expo-localtunnel": "workspace:*",
  },
}
```

Then run `vp install`. `expo-modules-autolinking` wires up the iOS and Android native modules — no extra native configuration is required by the consumer.

## Usage

```ts
import localtunnel from 'expo-localtunnel'

const tunnel = await localtunnel({ port: 8765 })

console.log('public URL:', tunnel.url)

tunnel.on('request', ({ method, path }) => {
  console.log('->', method, path)
})

tunnel.on('error', (err: Error & { code?: string }) => {
  console.warn('tunnel error', err.code, err.message)
})

tunnel.on('dead', () => {
  console.log('a tunnel connection died')
})

// later, when finished:
tunnel.close()
```

The factory accepts either an options object or a port plus options, and supports either a Promise or a node-style callback:

```ts
localtunnel({ port: 8765, subdomain: 'my-device' }).then((t) => {
  /* ... */
})
localtunnel(8765, { subdomain: 'my-device' }).then((t) => {
  /* ... */
})
localtunnel(8765, { subdomain: 'my-device' }, (err, t) => {
  /* ... */
})
```

## Options

`TunnelOptions` accepted by `localtunnel(...)`:

| Option             | Type      | Default                  | Description                                                                                 |
| ------------------ | --------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `port`             | `number`  | _required_               | Local TCP port the tunnel forwards to.                                                      |
| `host`             | `string`  | `https://localtunnel.me` | Relay base URL. Override to use a self-hosted localtunnel server.                           |
| `subdomain`        | `string`  | _(relay-assigned)_       | Request a specific subdomain on the relay (subject to availability and relay policy).       |
| `localHost`        | `string`  | `localhost`              | Hostname the device should connect to when forwarding bytes from the relay.                 |
| `localHttps`       | `boolean` | `false`                  | **Not supported** — passing `true` rejects with an error. Only plaintext HTTP is forwarded. |
| `localCert`        | `string`  | —                        | Reserved for HTTPS support. Currently unused.                                               |
| `localKey`         | `string`  | —                        | Reserved for HTTPS support. Currently unused.                                               |
| `localCa`          | `string`  | —                        | Reserved for HTTPS support. Currently unused.                                               |
| `allowInvalidCert` | `boolean` | `false`                  | Reserved for HTTPS support. Currently unused.                                               |

## Lifecycle and events

`localtunnel(opts)` returns a `Tunnel` (an `EventEmitter`) once the relay has assigned a URL and the first connection is open. Internally:

- `_init` fetches a tunnel from the relay with **exponential backoff** (1s, 2s, 4s, 8s, 16s — ~31s total). After the last attempt fails, the Promise rejects (or the callback gets an `Error`) and an `error` event is emitted.
- `_establish` opens up to `maxConn` native socket connections to the relay. When any one of them closes, a replacement is opened automatically until `close()` is called.
- `close()` aborts any in-flight retry (via an internal `AbortController`), tears down all native connections, and emits `close`. Subsequent `dead` events from in-flight sockets are suppressed.

Events emitted on the returned `Tunnel`:

| Event     | Payload                            | When                                                                                               |
| --------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `url`     | `string`                           | Once, when the relay assigns the public URL.                                                       |
| `request` | `{ method: string; path: string }` | Every parsed HTTP request seen on the tunnel, including subsequent requests over keep-alive.       |
| `error`   | `Error & { code?: string }`        | A native socket error. `code` propagates from the platform (e.g. `ECONNREFUSED`, `EHOSTUNREACH`).  |
| `dead`    | _none_                             | A single tunnel connection went down. The cluster opens a replacement unless `close()` was called. |
| `close`   | _none_                             | After `close()` finishes tearing down the cluster.                                                 |

## Platform notes

The native side handles socket relay and HTTP request parsing identically across platforms:

- **iOS** — Swift, built on `NWConnection` (Network framework).
- **Android** — Kotlin, built on `kotlinx.coroutines` and `java.net.Socket`.

Both implementations buffer partial reads, parse the HTTP request line per request (including pipelined keep-alive requests), and emit `onRequest` to JS for each one. Connection lifecycle events (`onConnectionOpen`, `onConnectionClose`, `onConnectionError`, `onConnectionDead`) are emitted with native error codes preserved on the `error` event payload.

## Limitations

- **No HTTPS to the local server.** `localHttps: true` throws. The device-side connection is plaintext HTTP only. The relay-to-client side is HTTPS terminated at the relay.
- **Public relay by default.** `localtunnel.me` is a free public relay with no SLAs. For anything beyond local development, run your own relay and pass it via `host`.
- **No `cachedUrl` handling beyond exposing it.** If the relay returns a `cached_url`, it's surfaced as `tunnel.cachedUrl` but no caching behavior is implemented client-side.

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) at the repo root for dev setup, code style, and PR conventions. The package follows the monorepo's Vite+ toolchain — run `vp check` and `vp test` from this directory.

## License

MIT
