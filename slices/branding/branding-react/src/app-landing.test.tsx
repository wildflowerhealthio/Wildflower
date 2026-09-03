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

  it('should render the tagline and every paragraph, but never the homepage status line', () => {
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

        // Assert — an app someone has reached is usable, so no status caveat
        const intro = within(screen.getByRole('region', { name }))
        expect(intro.getByText(tagline)).toBeDefined()
        if (status !== undefined) {
          expect(intro.queryByText(status)).toBeNull()
        }
        for (const paragraph of paragraphs) {
          expect(intro.getByText(paragraph)).toBeDefined()
        }

        cleanup()
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should render the numbered guide, with every step and the note, only for apps that have one', () => {
    fc.assert(
      fc.property(appSectionIdArb, (app) => {
        // Arrange
        const { guide } = APP_DESCRIPTIONS[app]

        // Act
        render(
          <AppLanding app={app}>
            <div />
          </AppLanding>
        )

        // Assert
        if (guide === undefined) {
          expect(screen.queryByRole('list')).toBeNull()
        } else {
          const section = within(screen.getByRole('region', { name: guide.title }))
          const items = section.getAllByRole('listitem').map((item) => item.textContent)
          expect(items).toStrictEqual([...guide.steps])
          if (guide.note !== undefined) {
            expect(section.getByText(guide.note)).toBeDefined()
          }
        }

        cleanup()
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it("should link to the rest of the project at the app's section on the marketing site", () => {
    fc.assert(
      fc.property(appSectionIdArb, (app) => {
        // Arrange / Act
        render(
          <AppLanding app={app}>
            <div />
          </AppLanding>
        )

        // Assert
        const link = screen.getByRole('link', { name: /Read about the rest of the project/ })
        expect(link.getAttribute('href')).toBe(anchorHref(fromApp, APP_DESCRIPTIONS[app].anchor))
        expect(link.getAttribute('href')).toMatch(/^https:\/\/wildflowerhealth\.io\/#/)

        cleanup()
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should place its children after the tagline and before the story, in DOM order', () => {
    fc.assert(
      fc.property(appSectionIdArb, (app) => {
        // Arrange
        const { tagline, paragraphs } = APP_DESCRIPTIONS[app]

        // Act
        render(
          <AppLanding app={app}>
            <button type="button">Connect</button>
          </AppLanding>
        )

        // Assert — on one column this is the reading order: what the app is,
        // then the way in, then the longer story
        const button = screen.getByRole('button', { name: 'Connect' })
        const taglineNode = screen.getByText(tagline)
        const firstParagraph = screen.getByText(paragraphs[0])
        expect(follows(button, taglineNode)).toBe(true)
        expect(follows(firstParagraph, button)).toBe(true)

        cleanup()
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

// Helpers

/** Whether `later` comes after `earlier` in document order. */
function follows(later: Element, earlier: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}
