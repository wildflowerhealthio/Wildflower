import { NativeModule, requireNativeModule } from 'expo'

import type {
  BodyEncoding,
  ExpoEffectPlatformModuleEvents,
  ServerOptions,
} from './ExpoEffectPlatform.types.ts'

declare class ExpoEffectPlatformModule extends NativeModule<ExpoEffectPlatformModuleEvents> {
  getNetworkInterfaces(): Record<string, string>
  startServer(port: number, options?: ServerOptions): Promise<void>
  stopServer(timeoutSeconds: number): Promise<void>
  respondToRequest(
    requestId: string,
    statusCode: number,
    headers: Record<string, ReadonlyArray<string>>,
    body: string,
    bodyEncoding: BodyEncoding
  ): Promise<void>
  respondToRequestWithFile(
    requestId: string,
    statusCode: number,
    headers: Record<string, ReadonlyArray<string>>,
    filePath: string,
    start: number | null,
    end: number | null
  ): Promise<void>
}

export default requireNativeModule<ExpoEffectPlatformModule>('ExpoEffectPlatform')
