import { createContext, useContext, type ReactNode } from 'react'

/**
 * The banner this entry renders above every route, threaded from the entry
 * (`RenderAppOptions.platformBanner`) exactly as `platformTabs` is, and read
 * by `<RootShell>`.
 *
 * @remarks
 * `main-tauri` passes the background server service's status banner, since
 * only its host runs the server; web entries pass `null`. Defaults to `null`,
 * so a shell mounted outside a provider renders no banner.
 */
const PlatformBannerContext = createContext<ReactNode>(null)

/** Read the entry's platform banner. */
const usePlatformBanner = (): ReactNode => useContext(PlatformBannerContext)

export { PlatformBannerContext, usePlatformBanner }
