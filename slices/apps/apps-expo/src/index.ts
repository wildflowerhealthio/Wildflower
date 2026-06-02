import { makeAppsHostHandlers } from './host-handlers.ts'
import { useAppsHostBinding } from './use-host-binding.ts'

/**
 * Apps slice Expo host surface. `useHostBinding` is the typical entry
 * point; `makeHostHandlers` is exported for direct composition (e.g. tests).
 */
const AppsBridgeExpo: {
  readonly makeHostHandlers: typeof makeAppsHostHandlers
  readonly useHostBinding: typeof useAppsHostBinding
} = {
  makeHostHandlers: makeAppsHostHandlers,
  useHostBinding: useAppsHostBinding,
}

export { AppsBridgeExpo }
export type { UseAppsHostBindingOptions } from './use-host-binding.ts'
