/**
 * Tests for `startTunnel` — the Node platform adapter for the tunnel
 * daemon's `startTunnel` contract.
 *
 * The implementation is a thin Effect/Stream wrapper around the
 * `localtunnel` npm package; tests inject a fake `OpenTunnel` so we
 * never talk to a real relay. The fake is a minimal EventEmitter that
 * exposes `url` and `close()` — the same surface the daemon contract
 * reads from.
 *
 * The contract under test:
 *
 *  1. The stream emits one initial `DomainResult` parsed out of the
 *     fake's `url` (subdomain = first hostname label, rootDomain = the
 *     rest);
 *  2. After that first emit, the stream parks until either the fake
 *     emits `'error'` (stream fails with that error) or the surrounding
 *     scope closes (acquire's release fires `handle.close()`);
 *  3. A pre-bind failure (the open promise rejects) terminates the
 *     stream with the rejection wrapped as an `Error`;
 *  4. A malformed `url` from the relay terminates the stream with an
 *     explanatory `Error` and the fake's `close()` still runs.
 *
 * Tests use `Stream.runCollect` against bounded sub-scopes so the
 * cleanup pathways are exercised explicitly.
 */
import { EventEmitter } from 'node:events'

import { Cause, Effect, Exit, Fiber, Stream } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import type { ResolvedConfig } from 'tunnel-core/daemon'
import { describe, expect, it } from 'vite-plus/test'

import type { OpenTunnel, OpenTunnelHandle, OpenTunnelOpts } from '../startTunnel.ts'
import { startTunnel } from '../startTunnel.ts'

const BASE_CONFIG: ResolvedConfig = {
  subdomain: 'wildflower-node-dev',
  rootDomain: 'localtunnel.me',
  localPort: 3000,
}

class FakeHandle extends EventEmitter implements OpenTunnelHandle {
  readonly url: string
  closed = false
  constructor(url: string) {
    super()
    this.url = url
  }
  close(): void {
    this.closed = true
    this.emit('close')
  }
}

interface OpenedSpy {
  readonly handles: FakeHandle[]
  readonly opts: OpenTunnelOpts[]
  readonly openTunnel: OpenTunnel
}

const makeOpenTunnelSpy = (urlFor: (opts: OpenTunnelOpts) => string): OpenedSpy => {
  const handles: FakeHandle[] = []
  const opts: OpenTunnelOpts[] = []
  const openTunnel: OpenTunnel = (o) => {
    opts.push(o)
    const h = new FakeHandle(urlFor(o))
    handles.push(h)
    return Promise.resolve(h)
  }
  return { handles, opts, openTunnel }
}

const makeFailingOpenTunnel =
  (err: unknown): OpenTunnel =>
  () =>
    Promise.reject(err)

describe('startTunnel — bind phase', () => {
  it('emits the parsed DomainResult once the open() promise resolves', async () => {
    const spy = makeOpenTunnelSpy(() => 'https://wildflower-node-dev.localtunnel.me')

    const result = await Effect.runPromise(
      Effect.scoped(Stream.runHead(startTunnel(BASE_CONFIG, spy.openTunnel)))
    )

    expect(result._tag).toBe('Some')
    if (result._tag === 'Some') {
      expect(result.value).toEqual({
        subdomain: 'wildflower-node-dev',
        rootDomain: 'localtunnel.me',
      })
    }
    expect(spy.opts).toEqual([
      { port: 3000, host: 'https://localtunnel.me', subdomain: 'wildflower-node-dev' },
    ])
    // Scope closed (Stream.runHead consumed via Effect.scoped) — the
    // handle's close() should have fired exactly once.
    expect(spy.handles[0]?.closed).toBe(true)
  })

  it('forwards the daemon-supplied localPort / rootDomain / subdomain into the open opts', async () => {
    const spy = makeOpenTunnelSpy(() => 'https://other.example.com')
    const cfg: ResolvedConfig = { subdomain: 'foo', rootDomain: 'example.com', localPort: 8080 }

    await Effect.runPromise(Effect.scoped(Stream.runHead(startTunnel(cfg, spy.openTunnel))))

    expect(spy.opts).toEqual([{ port: 8080, host: 'https://example.com', subdomain: 'foo' }])
  })

  it('reports a relay redirect: granted subdomain/rootDomain are taken from the URL, not the request', async () => {
    const spy = makeOpenTunnelSpy(() => 'https://redirected.altrelay.example')

    const result = await Effect.runPromise(
      Effect.scoped(Stream.runHead(startTunnel(BASE_CONFIG, spy.openTunnel)))
    )

    expect(result._tag).toBe('Some')
    if (result._tag === 'Some') {
      expect(result.value).toEqual({
        subdomain: 'redirected',
        rootDomain: 'altrelay.example',
      })
    }
  })

  it('treats a bare hostname as a subdomain under an empty rootDomain', async () => {
    const spy = makeOpenTunnelSpy(() => 'https://lonely')

    const result = await Effect.runPromise(
      Effect.scoped(Stream.runHead(startTunnel(BASE_CONFIG, spy.openTunnel)))
    )

    expect(result._tag).toBe('Some')
    if (result._tag === 'Some') {
      expect(result.value).toEqual({ subdomain: 'lonely', rootDomain: '' })
    }
  })

  it('fails the stream when the open() promise rejects with an Error, closes nothing (no handle was acquired)', async () => {
    const cause = new Error('relay unreachable')
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Stream.runCollect(startTunnel(BASE_CONFIG, makeFailingOpenTunnel(cause))))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause)
      expect(failure._tag).toBe('Some')
      if (failure._tag === 'Some') {
        expect(failure.value).toBe(cause)
      }
    }
  })

  it('wraps a non-Error rejection into an Error', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Stream.runCollect(startTunnel(BASE_CONFIG, makeFailingOpenTunnel('boom-string')))
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause)
      expect(failure._tag).toBe('Some')
      if (failure._tag === 'Some') {
        expect(failure.value).toBeInstanceOf(Error)
        expect(failure.value.message).toContain('boom-string')
      }
    }
  })

  it('fails the stream with a descriptive error if the relay returns a malformed URL', async () => {
    // `new URL('not a url')` throws; the implementation catches and
    // wraps. The handle has already been acquired, so cleanup must still
    // run on stream failure.
    const spy = makeOpenTunnelSpy(() => 'not a url')

    const exit = await Effect.runPromiseExit(
      Effect.scoped(Stream.runCollect(startTunnel(BASE_CONFIG, spy.openTunnel)))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause)
      expect(failure._tag).toBe('Some')
      if (failure._tag === 'Some') {
        expect(failure.value).toBeInstanceOf(Error)
        expect(failure.value.message).toMatch(/malformed URL/i)
      }
    }
    // Acquire ran before the parse failed, so close() must have fired
    // during teardown.
    expect(spy.handles[0]?.closed).toBe(true)
  })
})

describe('startTunnel — post-bind phase', () => {
  it("terminates the stream with the handle's 'error' event after the initial emit", async () => {
    const spy = makeOpenTunnelSpy(() => 'https://wildflower-node-dev.localtunnel.me')
    const postBindError = new Error('cluster reset')

    // Run the stream in a fiber, fail the handle from the outside, and
    // observe the stream terminate with that error.
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        Effect.scoped(Stream.runCollect(startTunnel(BASE_CONFIG, spy.openTunnel)))
      )
      // Wait for the handle to be acquired — open() resolves
      // synchronously here, but the daemon scope spin-up is async, so
      // poll briefly.
      yield* Effect.sync(() => {
        // intentionally empty — yield a tick
      })
      while (spy.handles[0] === undefined) {
        yield* Effect.sleep(1)
      }
      spy.handles[0].emit('error', postBindError)
      return yield* Fiber.await(fiber)
    })

    const exit = await Effect.runPromise(program)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause)
      expect(failure._tag).toBe('Some')
      if (failure._tag === 'Some') {
        expect(failure.value).toBe(postBindError)
      }
    }
    // Scope teardown still closes the handle even after a post-bind
    // failure — the acquire's release runs on stream-level failure too.
    expect(spy.handles[0]?.closed).toBe(true)
  })

  it("removes the 'error' listener when the scope closes cleanly (interruption path)", async () => {
    const spy = makeOpenTunnelSpy(() => 'https://wildflower-node-dev.localtunnel.me')

    const program = Effect.scoped(
      Effect.gen(function* () {
        // Fork the stream into the same scope but only collect the head
        // — the tail is then interrupted by the surrounding scope's
        // closure when the gen returns.
        const fiber = yield* Effect.fork(
          Stream.runCollect(startTunnel(BASE_CONFIG, spy.openTunnel))
        )
        while (spy.handles[0] === undefined) {
          yield* Effect.sleep(1)
        }
        // Initial emit has been observed by the time the handle is
        // populated (open() resolves synchronously); interrupt the tail.
        yield* Fiber.interrupt(fiber)
      })
    )

    await Effect.runPromise(program)

    // The error listener should be gone — handle's listenerCount('error')
    // should be 0 after cleanup runs.
    expect(spy.handles[0]?.listenerCount('error')).toBe(0)
    expect(spy.handles[0]?.closed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Property: hostname split is "first label = subdomain, rest = rootDomain"
// across any well-formed http(s) URL.
// ---------------------------------------------------------------------------

// Hostname labels: lowercase ASCII letters / digits / hyphens, 1–16
// chars, starting with a letter (the WHATWG URL parser rejects
// all-numeric labels in the public-suffix position — e.g. `http://a.0/`
// is invalid — and we don't want to fight that here; we're testing the
// parser, not URL grammar). `stringMatching` rejects regexes with the
// `i` flag, so we lowercase the alphabet directly. The shrinker prefers
// shorter strings, which surfaces boundary cases (single-char labels)
// early.
//
// Also exclude IDN A-label syntax (labels starting with `xn--`): the
// WHATWG URL parser runs ToASCII on the host and rejects labels whose
// Punycode payload is syntactically invalid (e.g. `xn--0`). That's URL
// grammar too — not what this property is exercising.
const hostnameLabel = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,15}$/)
  .filter((s) => !s.endsWith('-') && s.length > 0 && !s.startsWith('xn--'))

describe('startTunnel — granted-domain parsing (property)', () => {
  it('splits the granted hostname at the first dot', () =>
    fc.assert(
      fc.asyncProperty(
        hostnameLabel,
        fc.array(hostnameLabel, { minLength: 1, maxLength: 4 }).map((parts) => parts.join('.')),
        fc.constantFrom('http', 'https'),
        async (head, tail, scheme) => {
          const url = `${scheme}://${head}.${tail}/`
          const spy = makeOpenTunnelSpy(() => url)

          const result = await Effect.runPromise(
            Effect.scoped(Stream.runHead(startTunnel(BASE_CONFIG, spy.openTunnel)))
          )

          expect(result._tag).toBe('Some')
          if (result._tag === 'Some') {
            expect(result.value).toEqual({ subdomain: head, rootDomain: tail })
          }
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    ))
})
