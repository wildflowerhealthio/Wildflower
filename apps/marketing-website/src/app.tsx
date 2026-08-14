import type { JSX } from 'react'

import { Convergence } from './components/convergence.tsx'
import { Cta } from './components/cta.tsx'
import { Footer } from './components/footer.tsx'
import { Header } from './components/header.tsx'
import { Hero } from './components/hero.tsx'
import { Privacy } from './components/privacy.tsx'
import { Steps } from './components/steps.tsx'

/**
 * The landing page, top to bottom: a sticky header over the marketing
 * sections, with the footer outside `<main>`. Section order and ids match
 * the in-page nav targets (`#how`, `#privacy`, `#invite`).
 */
function App(): JSX.Element {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <Convergence />
        <Steps />
        <Privacy />
        <Cta />
      </main>
      <Footer />
    </>
  )
}

export { App }
