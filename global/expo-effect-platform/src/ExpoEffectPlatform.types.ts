type OnHttpRequestPayload = {
  requestId: string
  method: string
  path: string
  headers: Record<string, string>
  body: string | null
  bodyFilePath: string | null
  ip: string
}

type ServerOptions = {
  hostname?: string
  handlerTimeoutSeconds?: number
  bodyDiskThresholdBytes?: number
}

type ExpoEffectPlatformModuleEvents = {
  onHttpRequest: (params: OnHttpRequestPayload) => void
}

export type { OnHttpRequestPayload, ServerOptions, ExpoEffectPlatformModuleEvents }
