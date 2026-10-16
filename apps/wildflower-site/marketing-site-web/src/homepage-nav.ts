import { onMarketingSiteAt, type NavContext } from '@wildflowerhealthio/branding-core'

/**
 * The homepage's `NavContext`: anchors stay on this page, and section links go
 * into the copy of the site the page was served from — each app's own origin
 * on the published site, the preview's build of it on a PR preview.
 */
const homepageNav: NavContext = onMarketingSiteAt(document.baseURI)

export { homepageNav }
