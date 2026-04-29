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
}

type ExpoEffectPlatformModuleEvents = {
  onHttpRequest: (params: OnHttpRequestPayload) => void
}

type BodyEncoding = 'utf8' | 'base64'

export type { OnHttpRequestPayload, ServerOptions, ExpoEffectPlatformModuleEvents, BodyEncoding }
