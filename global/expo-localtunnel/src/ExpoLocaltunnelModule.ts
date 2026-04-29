import { NativeModule, requireNativeModule } from 'expo'

import type {
  ExpoLocaltunnelModuleEvents,
  TunnelConnectionConfig,
} from './ExpoLocaltunnel.types.ts'

declare class ExpoLocaltunnelModule extends NativeModule<ExpoLocaltunnelModuleEvents> {
  createTunnelConnection(connectionId: string, config: TunnelConnectionConfig): Promise<void>
  closeTunnelConnection(connectionId: string): Promise<void>
  closeAllTunnelConnections(): Promise<void>
}

export default requireNativeModule<ExpoLocaltunnelModule>('ExpoLocaltunnel')
