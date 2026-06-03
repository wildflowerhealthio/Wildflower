type OnHttpRequestPayload = {
  requestId: string
  method: string
  path: string
  headers: Record<string, ReadonlyArray<string>>
  body: string | null
  bodyBase64: string | null
  bodyFilePath: string | null
  ip: string
}

type ServerOptions = {
  hostname?: string
  handlerTimeoutSeconds?: number
  bodyDiskThresholdBytes?: number
  maxConcurrentRequests?: number
  fileSandboxRoots?: ReadonlyArray<string>
  /**
   * Grace period passed to the underlying server's stop routine — how long
   * to wait for in-flight requests to finish draining before closing the
   * listener. Defaults to 5 seconds for parity with a vanilla HTTP server.
   * Set lower (e.g. `0.5`) for hosts running inside short-budget contexts
   * (iOS background expiration, foreground-service teardown) where a fast
   * port release matters more than draining in-flight responses.
   */
  stopTimeoutSeconds?: number
}

type ExpoEffectPlatformModuleEvents = {
  onHttpRequest: (params: OnHttpRequestPayload) => void
}

type BodyEncoding = 'utf8' | 'base64'

export type { OnHttpRequestPayload, ServerOptions, ExpoEffectPlatformModuleEvents, BodyEncoding }
