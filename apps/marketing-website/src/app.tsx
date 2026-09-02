import type { JSX } from 'react'

import { onMarketingSite, SiteFooter, SiteHeader } from 'branding-react'

import { Convergence } from './components/convergence.tsx'
import { Cta } from './components/cta.tsx'
import { Hero } from './components/hero.tsx'
import { Privacy } from './components/privacy.tsx'
import { Steps } from './components/steps.tsx'

/**
 * The landing page, top to bottom: the shared site header (sticky, from
 * `branding-react`) over the marketing sections, with the shared site footer
 * outside `<main>`. Section order and ids match the in-page nav targets
 * (`#how`, `#privacy`, `#invite`).
 */
function App(): JSX.Element {
  return (
    <>
      <SiteHeader nav={onMarketingSite} />
      <main>
        <Hero />
        <Convergence />
        <Steps />
        <Privacy />
        <Cta />
      </main>
      <SiteFooter nav={onMarketingSite} />
    </>
  )
}

export { App }
