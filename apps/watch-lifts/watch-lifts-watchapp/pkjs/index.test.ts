import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { PhoneSettings } from 'watch-lifts-core-js/pkjs'

// src/index.ts is the glue between PebbleKit JS and the core: what the page's
// response means and the bytes the watch receives are PhoneSettings', tested
// in the core. These run the glue itself, loaded fresh per test over stand-ins
// for the PebbleKit JS globals (pebble-pkjs/pebble-kit-js): the page opened
// pre-filled, a save stored and sent, and the weights sent again.

/** src/index.ts, imported by URL so the Node-side type-check never loads its ES5 globals. */
const INDEX_URL = new URL('src/index.ts', import.meta.url).href

const SETTINGS: PhoneSettings.Settings = {
  weights: [
    [135, 95, 85, 65, 185],
    [115, 75, 70, 55, 155],
  ],
}

let listeners: Record<string, (event?: unknown) => void>
let sent: Array<unknown>
let opened: Array<string>
let storage: Map<string, string>
let sendSucceeds: boolean

beforeEach(async () => {
  listeners = {}
  sent = []
  opened = []
  storage = new Map()
  sendSucceeds = true
  vi.stubGlobal('Pebble', {
    addEventListener: (type: string, listener: (event?: unknown) => void) => {
      listeners[type] = listener
    },
    openURL: (url: string) => {
      opened.push(url)
    },
    sendAppMessage: (message: unknown, onSuccess: () => void, onFailure: (e: unknown) => void) => {
      if (sendSucceeds) {
        sent.push(message)
        onSuccess()
      } else {
        onFailure({ error: 'not running' })
      }
    },
  })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value)
    },
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.resetModules()
  await import(/* @vite-ignore */ INDEX_URL)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The page saves `settings`, as the phone app hands its response over. */
const save = (settings: PhoneSettings.Settings): void => {
  listeners['webviewclosed']?.({ response: encodeURIComponent(JSON.stringify(settings)) })
}

const pageUrl = (settings: PhoneSettings.Settings): string =>
  PhoneSettings.configurationUrl('https://wildflowerhealth.io/watch-lifts/', settings)

describe('the settings page', () => {
  it('should open with the default weights before any were saved', () => {
    listeners['showConfiguration']?.()
    expect(opened).toEqual([pageUrl(PhoneSettings.DEFAULT)])
  })

  it('should open with the weights last saved', () => {
    // Arrange
    save(SETTINGS)

    // Act
    listeners['showConfiguration']?.()

    // Assert
    expect(opened).toEqual([pageUrl(SETTINGS)])
  })
})

describe('a save', () => {
  it('should send the watch the weights', () => {
    save(SETTINGS)
    expect(sent).toEqual([PhoneSettings.toWatchMessage(SETTINGS)])
  })

  it('should change nothing when the page closed without saving', () => {
    // Arrange
    save(SETTINGS)
    sent = []

    // Act
    listeners['webviewclosed']?.({ response: '' })
    listeners['webviewclosed']?.({ response: undefined })
    listeners['showConfiguration']?.()

    // Assert
    expect(sent).toEqual([])
    expect(opened).toEqual([pageUrl(SETTINGS)])
  })
})

describe('the watchapp starting', () => {
  it('should send the weights last saved', () => {
    // Arrange
    save(SETTINGS)
    sent = []

    // Act
    listeners['ready']?.()

    // Assert
    expect(sent).toEqual([PhoneSettings.toWatchMessage(SETTINGS)])
  })

  it('should send nothing before any were saved, so the watch keeps its own', () => {
    listeners['ready']?.()
    expect(sent).toEqual([])
  })

  // The settings page can save while the watchapp isn't running.
  it('should reach the watch at its next start after a send that failed', () => {
    // Arrange
    sendSucceeds = false
    save(SETTINGS)
    sendSucceeds = true

    // Act
    listeners['ready']?.()

    // Assert
    expect(sent).toEqual([PhoneSettings.toWatchMessage(SETTINGS)])
  })
})
