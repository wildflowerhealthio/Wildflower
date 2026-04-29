import { Either, Schema } from 'effect'

import { HostToPageMessage, PageToHostMessage } from './embedded-webview-protocol'

describe('PageToHostMessage schema', () => {
  const decode = Schema.decodeUnknownEither(PageToHostMessage)

  it('accepts host:route with canGoBack', () => {
    expect(Either.isRight(decode({ type: 'host:route', canGoBack: true }))).toBe(true)
    expect(Either.isRight(decode({ type: 'host:route', canGoBack: false }))).toBe(true)
  })

  it('accepts host:ready and host:overrideReady', () => {
    expect(Either.isRight(decode({ type: 'host:ready' }))).toBe(true)
    expect(Either.isRight(decode({ type: 'host:overrideReady' }))).toBe(true)
  })

  it('accepts host:navigate with a path', () => {
    expect(Either.isRight(decode({ type: 'host:navigate', path: '/somewhere' }))).toBe(true)
  })

  it('rejects unknown type strings', () => {
    expect(Either.isLeft(decode({ type: 'host:back' }))).toBe(true)
    expect(Either.isLeft(decode({ type: 'unknown' }))).toBe(true)
  })

  it('rejects host:route without canGoBack', () => {
    expect(Either.isLeft(decode({ type: 'host:route' }))).toBe(true)
  })

  it('rejects host:navigate without path', () => {
    expect(Either.isLeft(decode({ type: 'host:navigate' }))).toBe(true)
  })

  it('rejects non-object values', () => {
    expect(Either.isLeft(decode(null))).toBe(true)
    expect(Either.isLeft(decode('host:ready'))).toBe(true)
    expect(Either.isLeft(decode(42))).toBe(true)
  })
})

describe('HostToPageMessage schema', () => {
  const decode = Schema.decodeUnknownEither(HostToPageMessage)

  it('accepts host:back', () => {
    expect(Either.isRight(decode({ type: 'host:back' }))).toBe(true)
  })

  it('rejects page-direction message types', () => {
    expect(Either.isLeft(decode({ type: 'host:ready' }))).toBe(true)
    expect(Either.isLeft(decode({ type: 'host:overrideReady' }))).toBe(true)
    expect(Either.isLeft(decode({ type: 'host:route', canGoBack: true }))).toBe(true)
  })
})
