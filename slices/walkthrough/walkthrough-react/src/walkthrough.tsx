import {
  WALKTHROUGH_ANCHOR_ATTRIBUTE,
  type WalkthroughStep,
} from '@wildflowerhealthio/walkthrough-core'
import { driver, type DestroyReason, type Driver, type PopoverDOM } from 'driver.js'
import 'driver.js/dist/driver.css'
import { Array, Duration, Match, Option } from 'effect'
import { useEffect, useEffectEvent } from 'react'

import styles from './walkthrough.module.css'

type WalkthroughProps = {
  /** The popovers in order. Read when the walkthrough starts. */
  readonly steps: ReadonlyArray<WalkthroughStep>
  /** Whether the walkthrough should be showing (`useWalkthrough().open`). */
  readonly open: boolean
  /** Called when the visitor presses Done on the last step (`useWalkthrough().finish`). */
  readonly onFinish: () => void
  /**
   * Called when the visitor leaves before the end: Skip, Escape, or a click on
   * the overlay (`useWalkthrough().skip`).
   */
  readonly onSkip: () => void
}

/** How long an opening walkthrough waits for every step's anchor to render. */
const ANCHOR_WAIT = Duration.seconds(2)

const SKIP_LABEL = 'Skip'

/** A step whose anchor is rendered on the page, with that anchor. */
interface AnchoredStep {
  readonly step: WalkthroughStep
  readonly anchorElement: Element
}

/** Whether `element` takes up space on the page: not `display: none`, nor inside it. */
const isRendered = (element: Element): boolean => element.getClientRects().length > 0

/** The first rendered element carrying `anchor`, if any. */
const findRenderedAnchor = (anchor: string): Option.Option<Element> =>
  Array.findFirst(
    document.querySelectorAll(`[${WALKTHROUGH_ANCHOR_ATTRIBUTE}]`),
    (element) =>
      element.getAttribute(WALKTHROUGH_ANCHOR_ATTRIBUTE) === anchor && isRendered(element)
  )

/** `steps` without the ones whose anchor is not rendered right now. */
const filterAnchoredSteps = (steps: ReadonlyArray<WalkthroughStep>): ReadonlyArray<AnchoredStep> =>
  Array.filterMap(steps, (step) =>
    Option.map(findRenderedAnchor(step.anchor), (anchorElement) => ({ step, anchorElement }))
  )

/**
 * Calls `onSettled` with `steps`' anchored steps once every anchor is
 * rendered, or once {@link ANCHOR_WAIT} has passed with whichever are.
 *
 * @returns A function that stops waiting without calling `onSettled`
 */
const waitForAnchoredSteps = (
  steps: ReadonlyArray<WalkthroughStep>,
  onSettled: (anchoredSteps: ReadonlyArray<AnchoredStep>) => void
): (() => void) => {
  const observer = new MutationObserver(() => {
    settleWhenAllAnchored()
  })
  const timeout = window.setTimeout(() => {
    settle()
  }, Duration.toMillis(ANCHOR_WAIT))
  const stopWaiting = (): void => {
    observer.disconnect()
    window.clearTimeout(timeout)
  }
  const settle = (): void => {
    stopWaiting()
    onSettled(filterAnchoredSteps(steps))
  }
  const settleWhenAllAnchored = (): void => {
    if (filterAnchoredSteps(steps).length === steps.length) settle()
  }
  observer.observe(document.body, { childList: true, subtree: true, attributes: true })
  settleWhenAllAnchored()
  return stopWaiting
}

/**
 * Restyles driver.js's popover for `step`: the module's BEM classes on its
 * parts, the step's words as plain text (driver.js writes them as HTML), and
 * the close button turned into a Skip button beside Back and Next.
 */
const dressPopover = (popover: PopoverDOM, step: WalkthroughStep): void => {
  popover.title.textContent = step.title
  popover.title.classList.add(styles['walkthrough__title'])
  popover.description.textContent = step.body
  popover.description.classList.add(styles['walkthrough__body'])
  popover.footer.classList.add(styles['walkthrough__footer'])
  popover.progress.classList.add(styles['walkthrough__progress'])
  popover.closeButton.textContent = SKIP_LABEL
  popover.closeButton.classList.add(
    styles['walkthrough__button'],
    styles['walkthrough__button--skip']
  )
  popover.footerButtons.prepend(popover.closeButton)
  popover.previousButton.classList.add(styles['walkthrough__button'])
  popover.nextButton.classList.add(
    styles['walkthrough__button'],
    styles['walkthrough__button--next']
  )
}

/** The callbacks that record how the visitor left a walkthrough. */
interface WalkthroughEndings {
  readonly onFinish: () => void
  readonly onSkip: () => void
}

/** Starts driver.js over `anchoredSteps`, reporting how the visitor leaves to `endings`. */
const startTour = (
  anchoredSteps: ReadonlyArray<AnchoredStep>,
  endings: WalkthroughEndings
): Driver => {
  const tour = driver({
    steps: anchoredSteps.map(({ step, anchorElement }) => ({
      element: anchorElement,
      popover: {
        title: step.title,
        description: step.body,
        onPopoverRender: (popover) => {
          dressPopover(popover, step)
        },
      },
    })),
    popoverClass: styles['walkthrough'],
    // The scrim is `--walkthrough-scrim`, set per colour scheme in the CSS module.
    overlayColor: 'var(--walkthrough-scrim)',
    overlayOpacity: 1,
    // react-tundraish's control radius (`--radius-3`), round the highlighted control.
    stageRadius: 12,
    allowClose: true,
    overlayClickBehavior: 'close',
    disableActiveInteraction: true,
    showButtons: ['next', 'previous', 'close'],
    showProgress: true,
    progressText: '{{current}} of {{total}}',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    closeBtnLabel: SKIP_LABEL,
    onDestroyStarted: (_element, _step, { driver: startedTour, reason }) => {
      startedTour.destroy()
      endTour(reason, endings)
    },
  })
  tour.drive()
  return tour
}

/**
 * Calls the ending `reason` stands for: `done` is Done on the last step;
 * `close`, `escape` and `overlay` are Skip, Escape and an overlay click. The
 * rest are not the visitor's doing and record nothing.
 */
const endTour = (reason: DestroyReason | undefined, endings: WalkthroughEndings): void => {
  Match.value(reason).pipe(
    Match.when('done', () => {
      endings.onFinish()
    }),
    Match.when(Match.is('close', 'escape', 'overlay'), () => {
      endings.onSkip()
    }),
    Match.when(Match.is('api', 'replaced'), () => undefined),
    Match.when(Match.undefined, () => undefined),
    Match.exhaustive
  )
}

/**
 * A first-run walkthrough: popovers, drawn by driver.js, that step through
 * the controls on the page carrying each step's anchor (see
 * `walkthroughAnchor`), with Skip, Back and Next (Done on the last step) and a
 * step counter. Renders nothing of its own.
 *
 * @remarks
 * **It starts once the page has rendered.** When `open` turns true it waits,
 * up to two seconds, for every step's anchor to be rendered, then shows the
 * steps whose anchor is: a step pointing at a control the page does not show
 * (a narrow layout, a closed tab) is dropped rather than pointing at nothing.
 * When no step is left it does not start, and nothing is recorded.
 *
 * Done on the last step calls `onFinish`; Skip, Escape and a click on the
 * overlay call `onSkip`. Turning `open` false or unmounting closes the
 * popovers without calling either.
 */
const Walkthrough = ({ steps, open, onFinish, onSkip }: WalkthroughProps): null => {
  const readSteps = useEffectEvent(() => steps)
  const handleFinish = useEffectEvent(onFinish)
  const handleSkip = useEffectEvent(onSkip)

  useEffect(() => {
    if (!open) return undefined
    let tour: Driver | undefined
    const stopWaiting = waitForAnchoredSteps(readSteps(), (anchoredSteps) => {
      if (anchoredSteps.length === 0) return
      tour = startTour(anchoredSteps, {
        onFinish: () => {
          handleFinish()
        },
        onSkip: () => {
          handleSkip()
        },
      })
    })
    return () => {
      stopWaiting()
      tour?.destroy()
    }
  }, [open])

  return null
}

export { Walkthrough, type WalkthroughProps }
