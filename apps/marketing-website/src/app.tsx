import type { JSX } from 'react'

import { Asks } from './components/asks.tsx'
import { Built } from './components/built.tsx'
import { DevTools } from './components/dev-tools.tsx'
import { Hero } from './components/hero.tsx'
import { Infrastructure } from './components/infrastructure.tsx'
import { RuthIntro } from './components/ruth-intro.tsx'
import { SameLanguage } from './components/same-language.tsx'
import { SiteFooter } from './components/site-footer.tsx'
import { SiteHeader } from './components/site-header.tsx'

/**
 * The homepage, top to bottom: header, hero (`#top`) with the manifesto
 * lines, the "I'm Ruth" intro (bio, stats), the FHIR explainer,
 * the apps (`#built`), the infrastructure (`#try`), the policy asks
 * (`#asks`), dev tooling (`#developers`), and the footer (`#note`). A
 * first-person essay, deliberately not a startup landing page: no signup
 * form, no pricing, no marketing CTA buttons — every call to action is a
 * text link into an app.
 */
function App(): JSX.Element {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <RuthIntro />
        <SameLanguage />
        <Built />
        <Infrastructure />
        <Asks />
        <DevTools />
      </main>
      <SiteFooter />
    </>
  )
}

export { App }
