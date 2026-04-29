import * as Etag from '@effect/platform/Etag'
import type * as FileSystem from '@effect/platform/FileSystem'
import * as HttpPlatform from '@effect/platform/HttpPlatform'
import * as ServerResponse from '@effect/platform/HttpServerResponse'
import * as Layer from 'effect/Layer'
import type { ExpoFileBody } from './httpServer.ts'

const make = HttpPlatform.make({
  fileResponse(path, status, statusText, headers, start, end, contentLength) {
    const body: ExpoFileBody = { __expoFilePath: path, start, end }
    return ServerResponse.raw(body, {
      status,
      statusText,
      headers,
      contentType: headers['content-type'] ?? 'application/octet-stream',
      contentLength,
    })
  },
  fileWebResponse(_file, status, statusText, headers) {
    return ServerResponse.raw('fileWebResponse is not supported in expo-effect-platform v1', {
      status: 501,
      statusText: statusText ?? 'Not Implemented',
      headers,
    })
  },
})

const layer: Layer.Layer<HttpPlatform.HttpPlatform, never, FileSystem.FileSystem> = Layer.effect(
  HttpPlatform.HttpPlatform,
  make
).pipe(Layer.provide(Etag.layerWeak))

export { make, layer }
