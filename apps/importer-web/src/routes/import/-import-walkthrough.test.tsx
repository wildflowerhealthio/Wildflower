import { HttpClient, HttpClientResponse } from '@effect/platform'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { buildSmartRouterContext } from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  readSeenWalkthrough,
  WALKTHROUGH_ANCHOR_ATTRIBUTE,
  writeSeenWalkthrough,
} from '@wildflowerhealthio/walkthrough-core'
import { DateTime, Effect, Layer } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { ImporterApp } from '../../app.tsx'
import { currentRoute, pageAt, stubPageBrowserApis } from '../../importer-app.test-helpers.ts'
import {
  IMPORTER_WALKTHROUGH_ID,
  IMPORTER_WALKTHROUGH_STEPS,
  IMPORTER_WALKTHROUGH_VERSION,
  ImporterPageWalkthroughAnchor,
} from './-import-walkthrough.ts'

beforeEach(() => {
  window.localStorage.clear()
  // jsdom lays nothing out, so every element reads as unrendered, and the
  // walkthrough would drop every step. Give each element a box.
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => {
    const boxes = [DOMRect.fromRect({ x: 0, y: 0, width: 40, height: 20 })]
    return Object.assign(boxes, { item: (index: number) => boxes[index] ?? null })
  })
  return stubPageBrowserApis()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
  // driver.js leaves its overlay on `body`, outside what `cleanup` unmounts.
  document.body.innerHTML = ''
})

/**
 * A FHIR server holding no uploaded source files: every search answers an
 * empty searchset, and every batch an empty batch response.
 */
const emptyServer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify(
            request.method === 'POST'
              ? { resourceType: 'Bundle', type: 'batch-response', entry: [] }
              : { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] }
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    )
  )
)

/** The Importer at `route` under the test basepath, over {@link emptyServer}. */
const renderImporterAt = (route: string): void => {
  const context = buildSmartRouterContext(
    { serverUrl: 'http://127.0.0.1:8080', accessToken: 'tok-abc' },
    emptyServer
  )
  render(<ImporterApp page={pageAt(route)} context={context} />)
}

/** The anchors on the page that a step of the Importer's walkthrough points at. */
const anchorsOnPage = (): ReadonlyArray<string> =>
  IMPORTER_WALKTHROUGH_STEPS.map(({ anchor }) => anchor).filter(
    (anchor) => document.querySelector(`[${WALKTHROUGH_ANCHOR_ATTRIBUTE}="${anchor}"]`) !== null
  )

/** The walkthrough's popover while it shows the step titled `title`. */
const findPopover = (title: string): Promise<HTMLElement> =>
  screen.findByRole('dialog', { name: title })

/** Keeps a record of the Importer's walkthrough, as a returning visitor has. */
const recordSeen = (): void => {
  writeSeenWalkthrough(window.localStorage, IMPORTER_WALKTHROUGH_ID, {
    version: IMPORTER_WALKTHROUGH_VERSION,
    outcome: 'Skipped',
    decidedAt: DateTime.unsafeMake('2026-10-22T12:00:00.000Z'),
  })
}

const recordedOutcome = (): string | undefined =>
  readSeenWalkthrough(window.localStorage, IMPORTER_WALKTHROUGH_ID, IMPORTER_WALKTHROUGH_VERSION)
    ?.outcome

/** A HAR with no entries: recognized as a HAR, it reads to a preview with nothing to import. */
const emptyHar = (): File =>
  new File(
    [
      JSON.stringify({
        log: { version: '1.2', creator: { name: 'test', version: '1' }, entries: [] },
      }),
    ],
    'empty.har',
    { type: 'application/json' }
  )

const [firstStep] = IMPORTER_WALKTHROUGH_STEPS
if (firstStep === undefined) {
  throw new Error('the walkthrough has no steps')
}

describe("the Importer's walkthrough", () => {
  it("should find every step's control on the Import tab, with no source files on the server", async () => {
    // Arrange
    recordSeen()

    // Act
    renderImporterAt('import')
    await screen.findByText('No source files have been uploaded to the FHIR server.')

    // Assert
    expect(anchorsOnPage()).toStrictEqual(IMPORTER_WALKTHROUGH_STEPS.map(({ anchor }) => anchor))
  })

  it('should keep only the tabs and Show walkthrough again once picked files are in review', async () => {
    // Arrange
    recordSeen()
    renderImporterAt('import')

    // Act
    await userEvent.upload(await screen.findByLabelText('Import file'), emptyHar())
    await screen.findByRole('button', { name: 'Cancel' })

    // Assert
    expect(anchorsOnPage()).toStrictEqual([
      ImporterPageWalkthroughAnchor.importTab,
      ImporterPageWalkthroughAnchor.anonymizeTab,
      ImporterPageWalkthroughAnchor.showAgain,
    ])
  })

  it('should open on a first visit, and stay closed once skipped', async () => {
    // Arrange
    renderImporterAt('import')

    // Act
    const popover = await findPopover(firstStep.title)
    fireEvent.click(within(popover).getByRole('button', { name: 'Skip' }))

    // Assert
    await waitFor(() => {
      expect(recordedOutcome()).toBe('Skipped')
    })
    expect(screen.queryByRole('dialog', { name: firstStep.title })).toBeNull()
  })

  it('should show again from Show walkthrough again, and drop the request once done', async () => {
    // Arrange
    recordSeen()
    renderImporterAt('anonymize')
    await screen.findByLabelText('File to anonymize')

    // Act
    await userEvent.click(screen.getByRole('link', { name: 'Show walkthrough again' }))
    // The Import tab is current while the request is in the address bar.
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Import' }).getAttribute('aria-current')).toBe('page')
    })
    const lastPopover = await IMPORTER_WALKTHROUGH_STEPS.slice(1).reduce(
      async (shown, { title }) => {
        fireEvent.click(within(await shown).getByRole('button', { name: 'Next' }))
        return findPopover(title)
      },
      findPopover(firstStep.title)
    )
    fireEvent.click(within(lastPopover).getByRole('button', { name: 'Done' }))

    // Assert
    await waitFor(() => {
      expect(recordedOutcome()).toBe('Finished')
    })
    await waitFor(() => {
      expect(window.location.search).toBe('')
    })
    expect(currentRoute()).toBe('import')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
