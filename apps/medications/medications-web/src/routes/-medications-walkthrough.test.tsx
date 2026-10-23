import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import {
  readSeenWalkthrough,
  WALKTHROUGH_ANCHOR_ATTRIBUTE,
  writeSeenWalkthrough,
} from '@wildflowerhealthio/walkthrough-core'
import { DateTime } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  awaitFirstPage,
  currentRoute,
  fetchMock,
  handshakeMock,
  lastPage,
  readyHandshake,
  setUpEachAppTest,
} from '../test-utils/app-fakes.ts'
import { renderApp } from '../test-utils/render-app.ts'
import {
  MEDICATIONS_WALKTHROUGH_ID,
  MEDICATIONS_WALKTHROUGH_STEPS,
  MEDICATIONS_WALKTHROUGH_VERSION,
  MedicationsWalkthroughAnchor,
} from './-medications-walkthrough.ts'

vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async () =>
  (await import('../test-utils/app-fakes.ts')).smartModuleFake()
)
vi.mock('./-tabs/interactions/-interaction-catalog.ts', async () =>
  (await import('../test-utils/app-fakes.ts')).interactionCatalogModuleFake()
)

setUpEachAppTest()

beforeEach(() => {
  window.localStorage.clear()
  // jsdom lays nothing out, so every element reads as unrendered, and the
  // walkthrough would drop every step. Give each element a box.
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => {
    const boxes = [DOMRect.fromRect({ x: 0, y: 0, width: 40, height: 20 })]
    return Object.assign(boxes, { item: (index: number) => boxes[index] ?? null })
  })
  handshakeMock.mockReturnValue(readyHandshake)
  fetchMock.mockResolvedValue(lastPage)
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  // driver.js leaves its overlay on `body`, outside what `cleanup` unmounts.
  document.body.innerHTML = ''
})

/** The anchors on the page that a step of the Medications walkthrough points at. */
const anchorsOnPage = (): ReadonlyArray<string> =>
  MEDICATIONS_WALKTHROUGH_STEPS.map(({ anchor }) => anchor).filter(
    (anchor) => document.querySelector(`[${WALKTHROUGH_ANCHOR_ATTRIBUTE}="${anchor}"]`) !== null
  )

/** The walkthrough's popover while it shows the step titled `title`. */
const findPopover = (title: string): Promise<HTMLElement> =>
  screen.findByRole('dialog', { name: title })

/** Keeps a record of the Medications walkthrough, as a returning visitor has. */
const recordSeen = (): void => {
  writeSeenWalkthrough(window.localStorage, MEDICATIONS_WALKTHROUGH_ID, {
    version: MEDICATIONS_WALKTHROUGH_VERSION,
    outcome: 'Skipped',
    decidedAt: DateTime.unsafeMake('2026-10-22T12:00:00.000Z'),
  })
}

const recordedOutcome = (): string | undefined =>
  readSeenWalkthrough(
    window.localStorage,
    MEDICATIONS_WALKTHROUGH_ID,
    MEDICATIONS_WALKTHROUGH_VERSION
  )?.outcome

const [firstStep] = MEDICATIONS_WALKTHROUGH_STEPS
if (firstStep === undefined) {
  throw new Error('the walkthrough has no steps')
}

describe('the Medications walkthrough', () => {
  it("should find every step's control on a patient's page, with no medications", async () => {
    // Arrange
    recordSeen()

    // Act
    renderApp({ route: 'patients/p1/medications' })
    await awaitFirstPage()
    await screen.findByText('No medications found.')

    // Assert
    expect(anchorsOnPage()).toStrictEqual(MEDICATIONS_WALKTHROUGH_STEPS.map(({ anchor }) => anchor))
  })

  it('should leave out Interactions on All patients, which has no such tab', async () => {
    // Arrange
    recordSeen()

    // Act
    renderApp({ route: 'medications' })
    await awaitFirstPage()
    await screen.findByText('No medications found.')

    // Assert
    expect(anchorsOnPage()).toStrictEqual([
      MedicationsWalkthroughAnchor.patientLine,
      MedicationsWalkthroughAnchor.medicationsTab,
      MedicationsWalkthroughAnchor.calendarTab,
      MedicationsWalkthroughAnchor.savingsTab,
    ])
  })

  it('should open on a first visit once the first page lands, and stay closed once skipped', async () => {
    // Arrange
    renderApp({ route: 'patients/p1/medications' })

    // Act
    const popover = await findPopover(firstStep.title)
    fireEvent.click(within(popover).getByRole('button', { name: 'Skip' }))

    // Assert
    await waitFor(() => {
      expect(recordedOutcome()).toBe('Skipped')
    })
    expect(screen.queryByRole('dialog', { name: firstStep.title })).toBeNull()
  })

  it('should show again from Show walkthrough again on the open tab, and drop the request once done', async () => {
    // Arrange
    recordSeen()
    renderApp({ route: 'patients/p1/calendar' })
    await awaitFirstPage()

    // Act
    fireEvent.click(screen.getByRole('link', { name: 'Show walkthrough again' }))
    const lastPopover = await MEDICATIONS_WALKTHROUGH_STEPS.slice(1).reduce(
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
    expect(currentRoute()).toBe('patients/p1/calendar')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
