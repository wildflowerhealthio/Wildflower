import { useContextOrThrow, useSubscribable } from 'react-kitchen-sink'

import { ActiveDeviceUserCodeContext } from './context.ts'

/**
 * Subscribe to the active pending device-consent `user_code`.
 * Re-renders on every change. Throws when used outside an
 * `<ActiveDeviceUserCodeProvider>` — accidental consumers without a
 * wired store have no useful fallback.
 *
 * The actual `Subscribable → React` bridge lives in
 * {@link useSubscribable}; this hook is the typed lookup against the
 * provider context plus a missing-provider throw.
 */
const useActiveDeviceUserCode = (): string | null => {
  const store = useContextOrThrow(ActiveDeviceUserCodeContext)
  return useSubscribable(store.subscribable)
}

export { useActiveDeviceUserCode }
