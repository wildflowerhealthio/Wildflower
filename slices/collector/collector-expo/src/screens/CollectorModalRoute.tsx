import { type JSX } from 'react'

import { useCollectorHost } from '../collector-host-context.tsx'
import { CollectorModalScreen } from './CollectorModalScreen.tsx'

/**
 * Default-export route component that hosts {@link CollectorModalScreen}.
 * The host shell underneath stays mounted (Stack `presentation: 'modal'`);
 * its WebView never tears down mid-scrape.
 *
 * Consumers register this in their expo-router file system by
 * re-exporting it as the default from a route file at the path
 * passed to `<HostProvider modalPath="…">` (default `/collector-modal`):
 *
 * ```ts
 * // apps/<your-app>/src/app/collector-modal.tsx
 * export { CollectorModalRoute as default } from 'collector-expo'
 * ```
 */
const CollectorModalRoute = (): JSX.Element => {
  const { pendingSource } = useCollectorHost()

  if (pendingSource === null) {
    // The route should only ever be pushed after the receiver layer's
    // `RequestSniffableWebView` handler set `pendingSource`. Fail
    // fast (matching `useCollectorHost`'s policy) rather than render
    // a misleading empty state.
    throw new Error(
      'CollectorModalRoute mounted without pendingSource — push via the receiver layer.'
    )
  }

  return <CollectorModalScreen source={pendingSource} />
}

export { CollectorModalRoute }
