# expo-effect-platform

[`@effect/platform`](https://github.com/Effect-TS/effect/tree/main/packages/platform) implementation backed by [Expo Modules](https://docs.expo.dev/modules/overview/). Run an `HttpServer` inside your React Native app — the native layer handles HTTP and file I/O, while Effect handles routing, middleware, and the request/response lifecycle.

## Why

Mobile apps sometimes need to serve HTTP locally — particularly local-first apps with no remote server. This module lets you do that with Effect's `HttpServer` and `HttpRouter` APIs instead of writing platform-specific networking code.

## Built on

| Layer   | Dependency                                                                            | Role                                                             |
| ------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| JS      | [`effect`](https://github.com/Effect-TS/effect)                                       | Runtime, Layer composition, Fibers                               |
| JS      | [`@effect/platform`](https://github.com/Effect-TS/effect/tree/main/packages/platform) | `HttpServer`, `HttpRouter`, `HttpServerRequest`/`Response` types |
| Bridge  | [Expo Modules API](https://github.com/expo/expo/tree/main/packages/expo-modules-core) | Native ↔ JS bridge, event emitter                                |
| iOS     | [FlyingFox](https://github.com/swhitty/FlyingFox) ~0.26                               | Lightweight async Swift HTTP server                              |
| Android | [Ktor CIO](https://github.com/ktorio/ktor) 3.0                                        | Kotlin coroutine-based HTTP server                               |

## Install

```sh
npx expo install expo-effect-platform
```

Peer dependencies:

```sh
npm install effect @effect/platform
```

## Quick start

```ts
import { Effect, Layer } from 'effect'
import { HttpRouter, HttpServer, HttpServerResponse } from '@effect/platform'
import { ExpoHttpServer, ExpoContext } from 'expo-effect-platform'

const router = HttpRouter.empty.pipe(
  HttpRouter.get('/', HttpServerResponse.text('Hello from Expo!')),
  HttpRouter.get('/json', HttpServerResponse.unsafeJson({ ok: true }))
)

const ServerLive = ExpoHttpServer.layer({ port: 8080 }).pipe(Layer.provide(ExpoContext.layer))

const program = router.pipe(HttpServer.serve(), Layer.provide(ServerLive), Layer.launch)

Effect.runFork(program)
```

## API

### `ExpoHttpServer.layer(options)`

Creates an `HttpServer` layer.

| Option                   | Type       | Default      | Description                                                                             |
| ------------------------ | ---------- | ------------ | --------------------------------------------------------------------------------------- |
| `port`                   | `number`   | _required_   | TCP port to listen on                                                                   |
| `hostname`               | `string`   | `127.0.0.1`  | Interface to bind. Use `0.0.0.0` to expose to LAN (see [Threat model](#threat-model))   |
| `handlerTimeoutSeconds`  | `number`   | —            | Max seconds per request before the server responds 504                                  |
| `bodyDiskThresholdBytes` | `number`   | `10_000_000` | Request bodies above this size are spilled to a temp file instead of kept in memory     |
| `maxConcurrentRequests`  | `number`   | `256`        | Cap on concurrent in-flight requests; the server returns 503 above this limit           |
| `fileSandboxRoots`       | `string[]` | App-defaults | Allow-listed prefixes for `respondToRequestWithFile`; paths outside any root return 403 |

### `ExpoContext.layer`

Provides the context services (`HttpPlatform`, `FileSystem`, `Etag`, `Path`) that `HttpServer.serve()` requires. Built on `@effect/platform`'s `HttpServer.layerContext` and overridden with the Expo-specific `HttpPlatform` so `HttpServerResponse.file()` passes paths to native for zero-copy file responses.

### `ExpoHttpPlatform.layer`

Lower-level — just the `HttpPlatform` service. Use this if you're composing your own context layer.

## What works

These `@effect/platform` features are fully supported:

- **`HttpRouter`** — all HTTP methods, path matching, nested routers
- **`HttpServerResponse`** — `.text()`, `.unsafeJson()`, `.raw()`, `.file()`, `.uint8Array()`, custom status codes, custom headers, cookies (including multiple `Set-Cookie` lines)
- **`HttpServerRequest`** — `.method`, `.url`, `.headers` (multi-valued), `.cookies`, `.remoteAddress`, `.text`, `.json`, `.urlParamsBody`, `.arrayBuffer`, `.stream`
- **Multi-valued headers** — multiple values for the same header (e.g. `Set-Cookie`, `X-Forwarded-For`) round-trip end-to-end as arrays without lossy comma joins
- **Binary bodies** — `Uint8Array` request and response bodies are byte-safe (base64 over the bridge); non-UTF-8 request bodies are surfaced via `req.arrayBuffer` / `req.stream`
- **File responses** — `HttpServerResponse.file()` passes the path directly to native; large files never cross the JS bridge as bytes; byte ranges (`offset`, `bytesToRead`) are honored
- **Large request bodies** — bodies above `bodyDiskThresholdBytes` are streamed to a temp file as they arrive (works for chunked-transfer requests with no `Content-Length`); a hard cap returns 413 on excessive bodies
- **Handler timeouts** — native layer returns 504 if the Effect handler exceeds `handlerTimeoutSeconds`
- **Graceful shutdown** — `stopServer` drains pending requests with 503

## What doesn't work (v1)

These `@effect/platform` features are **not yet implemented**:

| Feature                      | Behavior                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **WebSocket upgrade**        | `request.upgrade` fails with a `RequestError`                                                                 |
| **Multipart parsing**        | `request.multipart` / `request.multipartStream` fail with `MultipartError`                                    |
| **Truly chunked responses**  | Stream bodies are buffered into a single response (base64 over the bridge) — not chunk-streamed to the client |
| **Streaming request bodies** | `req.stream` from a disk-spilled body is read in chunks, but in-memory bodies emit as a single chunk          |
| **FormData responses**       | Returns an unsupported message                                                                                |
| **`fileWebResponse`**        | Returns 501                                                                                                   |

## Threat model

The defaults aim for safety on a single device:

- **Default bind is `127.0.0.1`** — the server is only reachable from inside the same device. Pass `hostname: '0.0.0.0'` to expose to the LAN, but only after considering what the JS handler can read.
- **`respondToRequestWithFile` is sandboxed** — by default file responses must resolve under the app's documents directory, cache directory, or temp directory. Override with `fileSandboxRoots` to allow specific extra paths. Symlinks are resolved before the prefix check so a symlink can't smuggle a path out of the sandbox.
- **Concurrent-request cap** — `maxConcurrentRequests` (default 256) limits how many requests can be in-flight at once; further requests return 503. Combined with `bodyDiskThresholdBytes` and the hard body-size cap, this bounds memory under a flood.

## Example app

The [`example/`](example/) directory contains an Expo app that starts the server and runs feature tests (text, JSON, POST echo, headers, query params, status codes, timeouts) with PASS/FAIL output.

```sh
cd example
npx expo run:ios   # or run:android
```

## License

MIT
