import { cleanup, render, screen, within } from '@testing-library/react'
import { APP_DESCRIPTIONS, APP_SECTION_IDS, type AppSectionId } from 'branding-core'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { AppLandingPage } from './app-landing-page.tsx'

// The homepage's SMART apps, and the owner UI, which has a landing page but no
// homepage row.
const appSectionIdArb = fc.constantFrom<AppSectionId>(...APP_SECTION_IDS, 'app')

afterEach(() => {
  cleanup()
})

describe('AppLandingPage', () => {
  it("should render the app's landing inside the main landmark, with its children", () => {
    fc.assert(
      fc.property(appSectionIdArb, (app) => {
        // Arrange / Act
        render(
          <AppLandingPage app={app}>
            <button type="button">Connect</button>
          </AppLandingPage>
        )

        // Assert — the app name is the page's only h1 (the header's brand is a div)
        const main = within(screen.getByRole('main'))
        const headings = screen.getAllByRole('heading', { level: 1 })
        expect(headings).toHaveLength(1)
        expect(main.getByRole('heading', { level: 1 }).textContent).toBe(APP_DESCRIPTIONS[app].name)
        expect(main.getByRole('button', { name: 'Connect' })).toBeDefined()

        cleanup()
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should put the site header before the main landmark and the footer after it', () => {
    // Arrange / Act
    render(
      <AppLandingPage app="medications">
        <div />
      </AppLandingPage>
    )

    // Assert — header, main, footer, in DOM order
    const header = screen.getByRole('banner')
    const main = screen.getByRole('main')
    const footer = screen.getByRole('contentinfo')
    expect(follows(main, header)).toBe(true)
    expect(follows(footer, main)).toBe(true)
  })

  it("should resolve the header's app links absolutely, as from an app", () => {
    // Arrange / Act
    render(
      <AppLandingPage app="webTrace">
        <div />
      </AppLandingPage>
    )

    // Assert — an app bundle on any origin points back at the canonical site
    const header = within(screen.getByRole('banner'))
    expect(header.getByRole('link', { name: 'Medications' }).getAttribute('href')).toBe(
      'https://wildflowerhealth.io/medications-app'
    )
  })

  it('should put the row above the footer between the main landmark and the footer', () => {
    // Arrange / Act
    render(
      <AppLandingPage app="medications" aboveFooter={<button type="button">Telemetry: off</button>}>
        <div />
      </AppLandingPage>
    )

    // Assert — outside the main landmark and the footer, after one and before the other
    const row = screen.getByRole('button', { name: 'Telemetry: off' })
    const main = screen.getByRole('main')
    const footer = screen.getByRole('contentinfo')
    expect(main.contains(row) || footer.contains(row)).toBe(false)
    expect(follows(row, main)).toBe(true)
    expect(follows(footer, row)).toBe(true)
  })
})

// Helpers

/** Whether `later` comes after `earlier` in document order. */
function follows(later: Element, earlier: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}
