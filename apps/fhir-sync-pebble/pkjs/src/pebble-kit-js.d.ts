// The globals PebbleKit JS provides, as far as this app uses them, per
// developer.repebble.com's PebbleKit JS reference. The phone's runtime is ES5
// with no DOM, so tsconfig.json's `lib` is ES5 alone and these stand in for
// the browser's declarations.

/** An AppMessage dictionary, keyed by `messageKeys` name. */
interface AppMessagePayload {
  readonly [key: string]: unknown
}

interface AppMessageEvent {
  readonly payload: AppMessagePayload
}

interface WebviewClosedEvent {
  /** What the configuration page returned; empty when it closed without saving. */
  readonly response: string | undefined
}

interface PebbleKitJs {
  addEventListener(type: 'showConfiguration', listener: () => void): void
  addEventListener(type: 'webviewclosed', listener: (event: WebviewClosedEvent) => void): void
  addEventListener(type: 'appmessage', listener: (event: AppMessageEvent) => void): void
  openURL(url: string): void
  /** Sends `message`, keyed by `messageKeys` name, to the watch. */
  sendAppMessage(message: object, onSuccess: () => void, onFailure: (error: unknown) => void): void
  /** The connected watch's platform, model, language and firmware. */
  getActiveWatchInfo(): unknown
}

declare const Pebble: PebbleKitJs

declare const localStorage: {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

declare class XMLHttpRequest {
  readonly status: number
  readonly responseText: string
  onload: (() => void) | null
  onerror: (() => void) | null
  open(method: string, url: string): void
  setRequestHeader(name: string, value: string): void
  send(body: string): void
}

declare const console: {
  error(message: string): void
}
