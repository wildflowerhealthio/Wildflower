// Custom jest environment that extends jsdom with modern Web API globals.
// jest-environment-jsdom doesn't expose Node.js built-in fetch APIs (Response,
// Request, Headers, TransformStream, etc.) because jsdom's window doesn't
// include them. This environment copies them from the outer Node.js context
// into the jsdom global scope, since environment setup() runs outside the VM.

const { TestEnvironment: JsdomEnvironment } = require('jest-environment-jsdom')

class WebEnvironment extends JsdomEnvironment {
  async setup() {
    await super.setup()

    // Stream APIs
    const streams = require('node:stream/web')
    this.global.ReadableStream = streams.ReadableStream
    this.global.WritableStream = streams.WritableStream
    this.global.TransformStream = streams.TransformStream

    // Text encoding
    this.global.TextEncoder = globalThis.TextEncoder
    this.global.TextDecoder = globalThis.TextDecoder

    // Fetch APIs (available in Node.js 18+ via built-in undici)
    this.global.Response = globalThis.Response
    this.global.Request = globalThis.Request
    this.global.Headers = globalThis.Headers
    this.global.fetch = globalThis.fetch
  }
}

module.exports = WebEnvironment
