import { NativeModule, requireNativeModule } from 'expo'

import type { ExpoEffectPlatformModuleEvents, ServerOptions } from './ExpoEffectPlatform.types.ts'

declare class ExpoEffectPlatformModule extends NativeModule<ExpoEffectPlatformModuleEvents> {
  getNetworkInterfaces(): Record<string, string>
  startServer(port: number, options?: ServerOptions): Promise<void>
  stopServer(timeoutSeconds: number): Promise<void>
  respondToRequest(
    requestId: string,
    statusCode: number,
    headers: Record<string, string>,
    body: string
  ): Promise<void>
  respondToRequestWithFile(
    requestId: string,
    statusCode: number,
    headers: Record<string, string>,
    filePath: string
  ): Promise<void>
}

export default requireNativeModule<ExpoEffectPlatformModule>('ExpoEffectPlatform')
