import { NativeModule, requireOptionalNativeModule } from 'expo'
import { Platform } from 'react-native'

import type {
  ExpoLocaltunnelModuleEvents,
  TunnelConnectionConfig,
} from './ExpoLocaltunnel.types.ts'

declare class ExpoLocaltunnelModule extends NativeModule<ExpoLocaltunnelModuleEvents> {
  createTunnelConnection(connectionId: string, config: TunnelConnectionConfig): Promise<void>
  closeTunnelConnection(connectionId: string): Promise<void>
  closeAllTunnelConnections(): Promise<void>
}

const native = requireOptionalNativeModule<ExpoLocaltunnelModule>('ExpoLocaltunnel')

const NOT_REGISTERED_MESSAGE =
  `ExpoLocaltunnel native module is not registered on ${Platform.OS}. ` +
  `Run a clean rebuild — Android: 'cd android && ./gradlew clean' then 'expo run:android'; ` +
  `iOS: 'cd ios && pod install' then 'expo run:ios'. ` +
  `If the rebuild succeeds but this error persists, the module isn't being autolinked.`

/**
 * Stub returned in place of the real module on platforms where it wasn't
 * autolinked. Lets the JS bundle finish evaluating (so the app renders and the
 * developer sees a useful error) instead of throwing at import time and
 * blanking the screen. Method calls reject with a diagnostic; `addListener`
 * returns a no-op subscription.
 */
function createStubModule(): ExpoLocaltunnelModule {
  const reject = (): Promise<never> => Promise.reject(new Error(NOT_REGISTERED_MESSAGE))
  const partial = {
    createTunnelConnection: reject,
    closeTunnelConnection: reject,
    closeAllTunnelConnections: reject,
    addListener: (): { remove: () => void } => ({ remove: (): void => undefined }),
  }
  // Cast across the `NativeModule` foundation class — fully stubbing all
  // inherited members (`emit`, `removeAllListeners`, etc.) is boilerplate that
  // adds no value on an already-error path. Falls under the "foundation /
  // bridge code that can't reasonably typecheck" exception in the project's
  // type-safety rules.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return partial as unknown as ExpoLocaltunnelModule
}

if (!native) {
  // oxlint-disable-next-line no-console
  console.warn(`[expo-localtunnel] ${NOT_REGISTERED_MESSAGE}`)
}

export default native ?? createStubModule()
