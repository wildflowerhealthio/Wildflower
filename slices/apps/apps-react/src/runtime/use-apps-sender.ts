import { useContext } from 'react'

import { AppsSenderContext, type AppsSender } from './apps-sender-context.ts'

/**
 * Returns the AppsBridge Web→Host sender. Throws when no
 * `<AppsSenderProvider>` is in the tree (the app's
 * `<AppsSenderForwarder>` always wraps the apps routes in one).
 */
const useAppsSender = (): AppsSender => {
  const sender = useContext(AppsSenderContext)
  if (sender === null) {
    throw new Error('useAppsSender must be used inside <AppsSenderProvider>')
  }
  return sender
}

export { useAppsSender }
