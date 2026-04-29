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

| Option                   | Type     | Default      | Description                                                                         |
| ------------------------ | -------- | ------------ | ----------------------------------------------------------------------------------- |
| `port`                   | `number` | _required_   | TCP port to listen on                                                               |
| `handlerTimeoutSeconds`  | `number` | —            | Max seconds per request before the server responds 504                              |
| `bodyDiskThresholdBytes` | `number` | `10 000 000` | Request bodies above this size are spilled to a temp file instead of kept in memory |

### `ExpoContext.layer`

Provides the context services (`HttpPlatform`, `FileSystem`, `Etag`, `Path`) that `HttpServer.serve()` requires. Uses `@effect/platform`'s built-in `layerContext` with an Expo-specific `HttpPlatform` that passes file paths to the native layer for zero-copy file responses.

### `ExpoHttpPlatform.layer`

Lower-level — just the `HttpPlatform` service. Use this if you're composing your own context layer.

## What works

These `@effect/platform` features are fully supported:

- **`HttpRouter`** — all HTTP methods, path matching, nested routers
- **`HttpServerResponse`** — `.text()`, `.unsafeJson()`, `.raw()`, `.file()`, custom status codes, custom headers, cookies
- **`HttpServerRequest`** — `.method`, `.url`, `.headers`, `.cookies`, `.remoteAddress`, `.text`, `.json`, `.urlParamsBody`, `.arrayBuffer`, `.stream`
- **`HttpServer.serve()`** — with optional middleware
- **File responses** — `HttpServerResponse.file()` passes the path directly to native; large files never cross the JS bridge as bytes
- **Large request bodies** — bodies above `bodyDiskThresholdBytes` are written to a temp file and read lazily, keeping memory bounded
- **Handler timeouts** — native layer returns 504 if the Effect handler exceeds `handlerTimeoutSeconds`
- **Graceful shutdown** — `stopServer` drains pending requests with 503

## What doesn't work (v1)

These `@effect/platform` features are **not yet implemented**:

| Feature                 | Behavior                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------ |
| **WebSocket upgrade**   | `request.upgrade` fails with a `RequestError`                                        |
| **Multipart parsing**   | `request.multipart` / `request.multipartStream` fail with `MultipartError`           |
| **Streaming responses** | Stream bodies are buffered into a single response — not truly streamed to the client |
| **FormData responses**  | Returns an unsupported message                                                       |
| **`fileWebResponse`**   | Returns 501                                                                          |

## Example app

The [`example/`](example/) directory contains an Expo app that starts the server and runs feature tests (text, JSON, POST echo, headers, query params, status codes, timeouts) with PASS/FAIL output.

```sh
cd example
npx expo run:ios   # or run:android
```

## License

MIT
