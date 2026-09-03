import { cleanup, render, screen, within } from '@testing-library/react'
import {
  APP_DESCRIPTIONS,
  APP_SECTION_IDS,
  anchorHref,
  fromApp,
  type AppSectionId,
} from 'branding-core'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { AppLanding } from './app-landing.tsx'

const appSectionIdArb = fc.constantFrom<AppSectionId>(...APP_SECTION_IDS)

afterEach(() => {
  cleanup()
})

describe('AppLanding', () => {
  it('should render the app name as the only h1, labelling the intro region', () => {
    fc.assert(
      fc.property(appSectionIdArb, (app) => {
        // Arrange / Act
        render(
          <AppLanding app={app}>
            <div />
          </AppLanding>
        )

        // Assert
        const headings = screen.getAllByRole('heading', { level: 1 })
        expect(headings).toHaveLength(1)
        expect(headings[0].textContent).toBe(APP_DESCRIPTIONS[app].name)
        expect(screen.getByRole('region', { name: APP_DESCRIPTIONS[app].name })).toBeDefined()

        cleanup()
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should render the tagline, the status when present, and every paragraph', () => {
    fc.assert(
      fc.property(appSectionIdArb, (app) => {
        // Arrange
        const { name, tagline, status, paragraphs } = APP_DESCRIPTIONS[app]

        // Act
        render(
          <AppLanding app={app}>
            <div />
          </AppLanding>
        )

        // Assert
        const intro = within(screen.getByRole('region', { name }))
        expect(intro.getByText(tagline)).toBeDefined()
        if (status !== undefined) {
          expect(intro.getByText(status)).toBeDefined()
        }
        for (const paragraph of paragraphs) {
          expect(intro.getByText(paragraph)).toBeDefined()
        }

        cleanup()
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it("should link back to the app's section on the marketing site as an absolute URL", () => {
    fc.assert(
      fc.property(appSectionIdArb, (app) => {
        // Arrange / Act
        render(
          <AppLanding app={app}>
            <div />
          </AppLanding>
        )

        // Assert
        const link = screen.getByRole('link', { name: /Read the whole story/ })
        expect(link.getAttribute('href')).toBe(anchorHref(fromApp, APP_DESCRIPTIONS[app].anchor))
        expect(link.getAttribute('href')).toMatch(/^https:\/\/wildflowerhealth\.io\/#/)

        cleanup()
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should render its children as the action area beside the intro', () => {
    // Arrange / Act
    render(
      <AppLanding app="medications">
        <button type="button">Connect</button>
      </AppLanding>
    )

    // Assert — the action area is outside the intro region
    const button = screen.getByRole('button', { name: 'Connect' })
    expect(
      within(screen.getByRole('region', { name: 'Medication Viewer' })).queryByRole('button')
    ).toBeNull()
    expect(button).toBeDefined()
  })
})
