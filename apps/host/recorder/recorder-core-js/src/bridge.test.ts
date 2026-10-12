import { BrowserSnifferBridge } from '@wildflowerhealthio/browser-sniffer-core'
import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import golden from '../../recorder-wire-golden.json' with { type: 'json' }
import { HarSaveFailed, HarSaved, HttpUrl, Open, RecorderBridge, SaveHar } from './bridge.ts'

/**
 * `recorder-wire-golden.json` holds one wire payload per tag, as the Tauri
 * transport carries it: a structured value, checked against each schema's
 * struct side (`Schema.typeSchema`), as `PageDispatcher` checks an inbound
 * payload. `recorder-rust`'s serde mirror of the save channel reads the same
 * file, and `browser-sniffer-tauri` emits and routes the rest unchanged.
 */

type HostToWebTag = keyof typeof golden.hostToWeb
type WebToHostTag = keyof typeof golden.webToHost

/** Decode a structured wire payload as the page dispatcher does. */
const decodeWire = (schema: Schema.Schema.AnyNoContext, payload: unknown): unknown =>
  Schema.decodeUnknownSync(Schema.typeSchema(schema))(payload)

/** Decode a structured wire payload, then encode it back as the page sends it. */
const encodeWire = (schema: Schema.Schema.AnyNoContext, payload: unknown): unknown => {
  const struct = Schema.typeSchema(schema)
  return Schema.encodeUnknownSync(struct)(Schema.decodeUnknownSync(struct)(payload))
}

/** The sniffer's data-plane tags, which the recorder takes from `browser-sniffer-core`. */
const DATA_PLANE_TAGS = [
  'ResponseStart',
  'ResponseData',
  'ResponseFinished',
  'RequestError',
  'Cancelled',
  'PageLoaded',
  'PageRequested',
] as const

const hostToWebTags = (): readonly HostToWebTag[] =>
  Object.keys(RecorderBridge.HostToWeb).filter(
    (tag): tag is HostToWebTag => tag in golden.hostToWeb
  )

const webToHostTags = (): readonly WebToHostTag[] =>
  Object.keys(RecorderBridge.WebToHost).filter(
    (tag): tag is WebToHostTag => tag in golden.webToHost
  )

describe('RecorderBridge', () => {
  it('should declare exactly the tags the golden file pins, on the side it pins them', () => {
    // Assert — a tag must be unique across every listener on the shared
    // channel, so which side declares which is part of the contract.
    expect(Object.keys(RecorderBridge.HostToWeb).toSorted()).toEqual(
      Object.keys(golden.hostToWeb).toSorted()
    )
    expect(Object.keys(RecorderBridge.WebToHost).toSorted()).toEqual(
      Object.keys(golden.webToHost).toSorted()
    )
    expect(RecorderBridge.name).toBe('Recorder')
  })

  it('should decode every host-to-web golden payload to itself', () => {
    for (const tag of hostToWebTags()) {
      // Act
      const decoded = decodeWire(RecorderBridge.HostToWeb[tag], golden.hostToWeb[tag])

      // Assert
      expect(decoded, tag).toEqual(golden.hostToWeb[tag])
    }
  })

  it('should decode the sniffer data plane exactly as the sniffer bridge does', () => {
    for (const tag of DATA_PLANE_TAGS) {
      // Arrange
      const payload = golden.hostToWeb[tag]

      // Act
      const asRecorder = decodeWire(RecorderBridge.HostToWeb[tag], payload)
      const asSniffer = decodeWire(BrowserSnifferBridge.WebToHost[tag], payload)

      // Assert — the same schemas, so the host's re-broadcast of a sniffer
      // event reaches the recorder as the sniffer posted it.
      expect(asRecorder, tag).toEqual(asSniffer)
    }
  })

  it('should send every web-to-host message in its golden wire shape', () => {
    for (const tag of webToHostTags()) {
      // Act
      const encoded = encodeWire(RecorderBridge.WebToHost[tag], golden.webToHost[tag])

      // Assert
      expect(encoded, tag).toEqual(golden.webToHost[tag])
    }
  })

  it('should refuse to open anything but an http(s) URL', () => {
    for (const uri of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://files.example.com']) {
      // Act / Assert — the host's decoder refuses these too.
      expect(() =>
        Schema.decodeUnknownSync(Schema.typeSchema(Open))({
          _tag: 'Open',
          source: { _tag: 'Uri', uri },
        })
      ).toThrow()
      expect(Schema.is(HttpUrl)(uri)).toBe(false)
    }
  })
})

describe('the save channel', () => {
  it('should decode its JSON-string wire', () => {
    // Act
    const saved = Schema.decodeUnknownSync(HarSaved)(JSON.stringify(golden.hostToWeb.HarSaved))
    const failed = Schema.decodeUnknownSync(HarSaveFailed)(
      JSON.stringify(golden.hostToWeb.HarSaveFailed)
    )
    const save = Schema.decodeUnknownSync(SaveHar)(JSON.stringify(golden.webToHost.SaveHar))

    // Assert
    expect(saved).toEqual(golden.hostToWeb.HarSaved)
    expect(failed).toEqual(golden.hostToWeb.HarSaveFailed)
    expect(save.text).toBe('{"log":{}}')
  })

  it('should refuse a SaveHar with an empty file name', () => {
    // Act / Assert — the host validates the name too, but a message that could
    // never name a file should not reach it.
    expect(() =>
      Schema.decodeUnknownSync(SaveHar)('{"_tag":"SaveHar","fileName":"","text":"{}"}')
    ).toThrow()
  })

  it('should accept an empty archive text, which is not the same as an absent one', () => {
    // Act
    const message = Schema.decodeUnknownSync(SaveHar)(
      '{"_tag":"SaveHar","fileName":"a.har","text":""}'
    )

    // Assert
    expect(message.text).toBe('')
    expect(() =>
      Schema.decodeUnknownSync(SaveHar)('{"_tag":"SaveHar","fileName":"a.har"}')
    ).toThrow()
  })
})
