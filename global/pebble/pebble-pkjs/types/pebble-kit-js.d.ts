// The globals PebbleKit JS provides, as far as the apps built with this
// package use them, per developer.repebble.com's PebbleKit JS reference. The
// phone's runtime is ES5 with no DOM, so an app's ES5 tsconfig.json has ES5's
// `lib` alone and lists this file in its `types` (as `pebble-pkjs/pebble-kit-js`)
// to stand in for the browser's declarations.

interface AppMessageEvent {
  /**
   * The AppMessage dictionary, keyed by `messageKeys` name. Typed `unknown` for
   * what it is, data from the watch; the app's decoders check its shape.
   */
  readonly payload: unknown
}

interface WebviewClosedEvent {
  /** What the configuration page returned; empty when it closed without saving. */
  readonly response: string | undefined
}

interface PebbleKitJs {
  /** PebbleKit JS has started with the watchapp and can send it messages. */
  addEventListener(type: 'ready', listener: () => void): void
  addEventListener(type: 'showConfiguration', listener: () => void): void
  addEventListener(type: 'webviewclosed', listener: (event: WebviewClosedEvent) => void): void
  addEventListener(type: 'appmessage', listener: (event: AppMessageEvent) => void): void
  openURL(url: string): void
  /** Sends `message`, keyed by `messageKeys` name, to the watch. */
  sendAppMessage(message: object, onSuccess: () => void, onFailure: (error: unknown) => void): void
  /** The connected watch's platform, model, language and firmware. */
  getActiveWatchInfo(): unknown
  /**
   * A token unique to the connected watch and this app. Typed `unknown`: an
   * older phone app may lack it or return something else, which the app's
   * decoders reject.
   */
  getWatchToken(): unknown
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
  abort(): void
  setRequestHeader(name: string, value: string): void
  send(body: string): void
}

declare function setTimeout(callback: () => void, delayMs: number): number
declare function clearTimeout(timeoutId: number): void

declare const console: {
  error(message: string): void
}
