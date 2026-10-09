import { PhoneSettings } from 'fhir-sync-pebble-core-js/pkjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

// src/index.ts is the glue between PebbleKit JS and the core: what it does
// with each message is WatchSync.receive's, tested in the core. These run the
// glue itself, loaded fresh per test over stand-ins for the PebbleKit JS
// globals (pebble-pkjs/pebble-kit-js), with fake timers: the settings sent
// again, the answer sent exactly once, the request's timeout.

/** src/index.ts, imported by URL so the Node-side type-check never loads its ES5 globals. */
const INDEX_URL = new URL('src/index.ts', import.meta.url).href

const SETTINGS: PhoneSettings.Settings = {
  patientId: 'ada-lovelace',
  patientName: 'Ada Lovelace',
  patientBirthDate: '1815-12-10',
  accessToken: 'token',
  fhirBaseUrl: 'https://fhir.example/r4',
}
const CONNECTION_ID = PhoneSettings.connectionId(SETTINGS)
const RECEIVED_AT_MS = 1_790_000_000_000

/** One XMLHttpRequest the glue made, and the stand-in's record of it. */
class FakeXmlHttpRequest {
  status = 0
  responseText = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  method = ''
  url = ''
  body: unknown = undefined
  aborted = false
  readonly headers: Record<string, string> = {}

  constructor() {
    requests.push(this)
  }

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value
  }

  send(body: string): void {
    if (throwOnSend) {
      throw new Error('send refused')
    }
    this.body = JSON.parse(body)
  }

  abort(): void {
    this.aborted = true
  }

  /** The server answers `status`. */
  answer(status: number): void {
    this.status = status
    this.onload?.()
  }
}

let listeners: Record<string, (event?: unknown) => void>
let sent: Array<unknown>
let requests: Array<FakeXmlHttpRequest>
let storage: Map<string, string>
let sendSucceeds: boolean
let throwOnSend: boolean
let watchToken: () => unknown

beforeEach(async () => {
  listeners = {}
  sent = []
  requests = []
  storage = new Map()
  sendSucceeds = true
  watchToken = () => 'a1b2c3'
  vi.useFakeTimers()
  vi.stubGlobal('Pebble', {
    addEventListener: (type: string, listener: (event?: unknown) => void) => {
      listeners[type] = listener
    },
    openURL: () => {},
    sendAppMessage: (message: unknown, onSuccess: () => void, onFailure: (e: unknown) => void) => {
      if (sendSucceeds) {
        sent.push(message)
        onSuccess()
      } else {
        onFailure({ error: 'not running' })
      }
    },
    getActiveWatchInfo: () => ({
      platform: 'emery',
      model: 'pebble_time_2_black',
      firmware: { major: 4, minor: 9, patch: 1, suffix: '' },
    }),
    getWatchToken: () => watchToken(),
  })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value)
    },
  })
  vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.resetModules()
  await import(/* @vite-ignore */ INDEX_URL)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const receive = (payload: unknown): void => {
  listeners['appmessage']?.({ payload })
}

const storeSettings = (): void => {
  storage.set('settings', PhoneSettings.toStored(SETTINGS, RECEIVED_AT_MS))
}

/** A sync of one walk from a watch holding `connectionId`. */
const sendWalkSync = (syncId: number, connectionId: string = CONNECTION_ID): void => {
  receive({ SyncStart: syncId, ConnectionId: connectionId })
  receive({ ActivityType: 4, ActivityStart: 1_790_000_000, ActivityEnd: 1_790_001_800 })
  receive({ ActivityCount: 1, MinuteHourCount: 0 })
}

const settingsMessage = PhoneSettings.toWatchMessage(SETTINGS, RECEIVED_AT_MS)

describe('the settings', () => {
  it('should be sent again, with the time they arrived, when the watchapp starts', () => {
    // Arrange
    storeSettings()

    // Act
    listeners['ready']?.()

    // Assert
    expect(sent).toEqual([settingsMessage])
  })

  it('should send nothing when the watchapp starts before any were saved', () => {
    listeners['ready']?.()
    expect(sent).toEqual([])
  })

  // The settings page can save while the watchapp isn't running.
  it('should reach the watch at its next start after a send that failed', () => {
    // Arrange
    sendSucceeds = false
    listeners['webviewclosed']?.({
      response: encodeURIComponent(JSON.stringify(SETTINGS)),
    })
    sendSucceeds = true

    // Act
    listeners['ready']?.()

    // Assert
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ ConnectionId: CONNECTION_ID })
  })
})

describe('a sync', () => {
  it('should PUT the sync and answer success once the server stores it', () => {
    // Arrange
    storeSettings()

    // Act
    sendWalkSync(7)
    const [request] = requests
    request?.answer(200)
    request?.onerror?.()

    // Assert
    expect(request).toMatchObject({ method: 'POST', url: SETTINGS.fhirBaseUrl })
    expect(request?.body).toMatchObject({
      type: 'transaction',
      entry: [{ request: { method: 'PUT' } }],
    })
    expect(sent).toEqual([{ SyncSucceeded: 1, SyncId: 7 }])
  })

  it('should answer failure once and abort when the server takes 60 s', () => {
    // Arrange
    storeSettings()
    sendWalkSync(7)

    // Act
    vi.advanceTimersByTime(59_999)
    const answeredEarly = sent.length
    vi.advanceTimersByTime(1)
    requests[0]?.answer(200)

    // Assert
    expect(answeredEarly).toBe(0)
    expect(requests[0]?.aborted).toBe(true)
    expect(sent).toEqual([{ SyncSucceeded: 0, SyncId: 7 }])
  })

  it('should answer failure once, and leave no timer, when the request cannot be sent', () => {
    storeSettings()
    throwOnSend = true
    sendWalkSync(7)
    vi.advanceTimersByTime(120_000)
    expect(sent).toEqual([{ SyncSucceeded: 0, SyncId: 7 }])
  })

  it('should fail without a request when the watch token is unavailable', () => {
    storeSettings()
    watchToken = () => {
      throw new Error('getWatchToken is not a function')
    }
    sendWalkSync(7)
    expect(requests).toEqual([])
    expect(sent).toEqual([{ SyncSucceeded: 0, SyncId: 7 }])
  })

  // Settings saved while the watchapp was closed, or during the sync: the
  // watch's last-sync times belong to another patient.
  it('should fail a sync from a watch holding another connection, and resend the settings', () => {
    storeSettings()
    sendWalkSync(7, 'wf-another-connection')
    expect(requests).toEqual([])
    expect(sent).toEqual([{ SyncSucceeded: 0, SyncId: 7 }, settingsMessage])
  })

  it('should fail a sync when no settings are stored', () => {
    sendWalkSync(7)
    expect(sent).toEqual([{ SyncSucceeded: 0, SyncId: 7 }])
  })

  it('should answer nothing to messages outside a sync', () => {
    storeSettings()
    receive({ ActivityType: 4, ActivityStart: 0, ActivityEnd: 60 })
    receive({ ActivityCount: 1, MinuteHourCount: 0 })
    expect(requests).toEqual([])
    expect(sent).toEqual([])
  })

  it('should answer success without a request for a sync with nothing to write', () => {
    storeSettings()
    receive({ SyncStart: 8, ConnectionId: CONNECTION_ID })
    receive({ ActivityCount: 0, MinuteHourCount: 0 })
    expect(requests).toEqual([])
    expect(sent).toEqual([{ SyncSucceeded: 1, SyncId: 8 }])
  })
})
