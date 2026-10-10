import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
/**
 * Wire tests over `test/bridge-wire-golden.json`, the exact strings the host
 * writes and reads. Pinning the text, not just the schema, means a field
 * renamed, reordered or re-cased fails here instead of drifting from the host.
 */
import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import golden from '../test/bridge-wire-golden.json' with { type: 'json' }
import {
  BackgroundServerServiceBridge,
  RestartServer,
  ServerServiceStatus,
  ServiceStopReason,
} from './bridge.ts'

const decodeStatus = Schema.decodeUnknownSync(ServerServiceStatus)
const encodeStatus = Schema.encodeSync(ServerServiceStatus)

/** Every field the host always writes, in the order its serde mirror writes them. */
const STATUS_WIRE_KEYS = ['_tag', 'state', 'stopReason', 'lastError', 'notifications'] as const

/** The wire text as a plain object, keys in the order the text writes them. */
const decodeWireObject = Schema.decodeUnknownSync(
  Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown }))
)

const arbitraryStatus = Arbitrary.make(Schema.typeSchema(ServerServiceStatus))

describe('BackgroundServerServiceBridge', () => {
  it('should declare the status to the page and the restart to the host', () => {
    // Assert — a tag must be unique across every listener on the shared
    // channel, so which side declares which is part of the contract.
    expect(BackgroundServerServiceBridge.name).toBe('BackgroundServerService')
    expect(Object.keys(BackgroundServerServiceBridge.HostToWeb)).toEqual(['ServerServiceStatus'])
    expect(Object.keys(BackgroundServerServiceBridge.WebToHost)).toEqual(['RestartServer'])
  })
})

describe('ServerServiceStatus', () => {
  it('should decode the running golden string with every optional field null', () => {
    // Act
    const status = decodeStatus(golden.serverServiceStatus.running)

    // Assert
    expect(status).toEqual({
      _tag: 'ServerServiceStatus',
      state: 'running',
      stopReason: null,
      lastError: null,
      notifications: 'granted',
    })
  })

  it('should decode the stopped golden string with every optional field present', () => {
    // Act
    const status = decodeStatus(golden.serverServiceStatus.stopped)

    // Assert
    expect(status).toEqual({
      _tag: 'ServerServiceStatus',
      state: 'stopped',
      stopReason: 'platformExpiration',
      lastError: 'failed to bind to 127.0.0.1:8080: Address already in use',
      notifications: 'denied',
    })
  })

  it('should decode the starting golden string, which still carries the last stop reason', () => {
    // Act
    const status = decodeStatus(golden.serverServiceStatus.starting)

    // Assert
    expect(status).toEqual({
      _tag: 'ServerServiceStatus',
      state: 'starting',
      stopReason: 'appStop',
      lastError: null,
      notifications: 'unknown',
    })
  })

  it.each(Object.entries(golden.serverServiceStatus))(
    'should re-encode the %s golden string byte for byte',
    (_name, wire) => {
      // Act / Assert
      expect(encodeStatus(decodeStatus(wire))).toBe(wire)
    }
  )

  it('should know exactly the stop reasons the host can send', () => {
    // Assert
    expect(ServiceStopReason.literals).toEqual(golden.stopReasons)
  })

  it('should round-trip any status through its wire text in the host’s field order', () => {
    fc.assert(
      fc.property(arbitraryStatus, (status) => {
        // Act
        const wire = encodeStatus(status)

        // Assert
        expect(decodeStatus(wire)).toEqual(status)
        expect(Object.keys(decodeWireObject(wire))).toEqual(STATUS_WIRE_KEYS)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should refuse a status with any field absent, since the host writes null rather than omitting', () => {
    fc.assert(
      fc.property(
        arbitraryStatus,
        fc.constantFrom(...STATUS_WIRE_KEYS.filter((key) => key !== '_tag')),
        (status, absentKey) => {
          // Arrange
          const withoutKey = Object.fromEntries(
            Object.entries(status).filter(([key]) => key !== absentKey)
          )

          // Act / Assert
          expect(() => decodeStatus(JSON.stringify(withoutKey))).toThrow()
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it.each([
    [
      'an unknown state',
      '{"_tag":"ServerServiceStatus","state":"paused","stopReason":null,"lastError":null,"notifications":"granted"}',
    ],
    [
      'an unknown stop reason',
      '{"_tag":"ServerServiceStatus","state":"stopped","stopReason":"somethingNew","lastError":null,"notifications":"granted"}',
    ],
    [
      'an unknown permission',
      '{"_tag":"ServerServiceStatus","state":"running","stopReason":null,"lastError":null,"notifications":"prompt"}',
    ],
    [
      'a snake_case field',
      '{"_tag":"ServerServiceStatus","state":"running","stop_reason":null,"lastError":null,"notifications":"granted"}',
    ],
  ])('should refuse %s', (_label, wire) => {
    // Act / Assert
    expect(() => decodeStatus(wire)).toThrow()
  })
})

describe('RestartServer', () => {
  it('should encode to the golden string the host decodes', () => {
    // Act
    const wire = Schema.encodeSync(RestartServer)({ _tag: 'RestartServer' })

    // Assert
    expect(wire).toBe(golden.restartServer)
  })
})
