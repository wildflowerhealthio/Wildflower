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
  /**
   * Called when the walkthrough cannot show: no step's anchor is visible, or
   * another walkthrough is already showing (`useWalkthrough().postpone`).
   */
  readonly onPostpone: () => void
}

/** The longest an opening walkthrough waits for the page to settle. */
const ANCHOR_WAIT = Duration.seconds(2)

/** How long the visible anchors must stay unchanged for the page to count as settled. */
const ANCHOR_QUIET = Duration.millis(200)

const SKIP_LABEL = 'Skip'

/** A step whose anchor is visible on the page, with that anchor. */
interface AnchoredStep {
  readonly step: WalkthroughStep
  readonly anchorElement: Element
}

/**
 * Whether the visitor can see `element`: it has a box, and is not
 * `visibility: hidden` or fully transparent.
 *
 * @remarks
 * A browser without `checkVisibility` (WebKit before 17.4, which the host's
 * iOS 14 floor still allows) checks for a box alone.
 */
const isVisible = (element: Element): boolean => {
  const maybeChecking: Partial<Pick<Element, 'checkVisibility'>> = element
  return maybeChecking.checkVisibility === undefined
    ? element.getClientRects().length > 0
    : element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
}

/** The first visible element carrying `anchor`, if any. */
const findVisibleAnchor = (anchor: string): Option.Option<Element> =>
  Array.findFirst(
    document.querySelectorAll(`[${WALKTHROUGH_ANCHOR_ATTRIBUTE}="${CSS.escape(anchor)}"]`),
    isVisible
  )

/** `steps` without the ones whose anchor is not visible right now. */
const filterAnchoredSteps = (steps: ReadonlyArray<WalkthroughStep>): ReadonlyArray<AnchoredStep> =>
  Array.filterMap(steps, (step) =>
    Option.map(findVisibleAnchor(step.anchor), (anchorElement) => ({ step, anchorElement }))
  )

/** Whether `next` holds other anchors, or other elements for them, than `previous`. */
const anchorsChanged = (
  previous: ReadonlyArray<AnchoredStep>,
  next: ReadonlyArray<AnchoredStep>
): boolean =>
  previous.length !== next.length ||
  next.some(({ anchorElement }, index) => previous[index]?.anchorElement !== anchorElement)

/**
 * Calls `onSettled` with `steps`' anchored steps once the page has settled:
 * at once when every anchor is visible, once at least one is and they have
 * not changed for {@link ANCHOR_QUIET}, or once {@link ANCHOR_WAIT} has
 * passed with whichever are.
 *
 * @returns A function that stops waiting without calling `onSettled`
 */
const waitForAnchoredSteps = (
  steps: ReadonlyArray<WalkthroughStep>,
  onSettled: (anchoredSteps: ReadonlyArray<AnchoredStep>) => void
): (() => void) => {
  let anchoredSteps: ReadonlyArray<AnchoredStep> = []
  let quietTimeout: number | undefined
  const observer = new MutationObserver(() => {
    checkAnchors()
  })
  const waitTimeout = window.setTimeout(() => {
    settle()
  }, Duration.toMillis(ANCHOR_WAIT))
  const stopWaiting = (): void => {
    observer.disconnect()
    window.clearTimeout(waitTimeout)
    window.clearTimeout(quietTimeout)
  }
  const settle = (): void => {
    stopWaiting()
    onSettled(anchoredSteps)
  }
  const checkAnchors = (): void => {
    const nextAnchoredSteps = filterAnchoredSteps(steps)
    const changed = anchorsChanged(anchoredSteps, nextAnchoredSteps)
    anchoredSteps = nextAnchoredSteps
    if (anchoredSteps.length === steps.length) {
      settle()
    } else if (changed) {
      window.clearTimeout(quietTimeout)
      quietTimeout =
        anchoredSteps.length > 0
          ? window.setTimeout(() => {
              settle()
            }, Duration.toMillis(ANCHOR_QUIET))
          : undefined
    }
  }
  observer.observe(document.body, { childList: true, subtree: true, attributes: true })
  checkAnchors()
  return stopWaiting
}

/**
 * Fills in and restyles driver.js's popover for `step`: the step's words as
 * plain text (driver.js is given none, since it writes them as HTML), the
 * module's BEM classes on its parts, and the close button turned into a Skip
 * button beside Back and Next.
 */
const dressPopover = (popover: PopoverDOM, step: WalkthroughStep): void => {
  popover.title.textContent = step.title
  popover.title.style.display = 'block'
  popover.title.classList.add(styles['walkthrough__title'])
  popover.description.textContent = step.body
  popover.description.style.display = 'block'
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

/** The tour showing on the page; driver.js shows one at a time. */
let showingTour: Driver | undefined

/** Starts driver.js over `anchoredSteps`, reporting how the visitor leaves to `endings`. */
const startTour = (
  anchoredSteps: ReadonlyArray<AnchoredStep>,
  endings: WalkthroughEndings
): Driver => {
  const tour = driver({
    steps: anchoredSteps.map(({ step, anchorElement }) => ({
      // Looked up again when the step shows, in case the page has re-rendered
      // the control since the walkthrough started.
      element: () => Option.getOrElse(findVisibleAnchor(step.anchor), () => anchorElement),
      popover: {
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
  showingTour = tour
  return tour
}

/**
 * Calls the ending `reason` stands for: `done` is Done, or the right arrow
 * key, on the last step; `close`, `escape` and `overlay` are Skip, Escape and
 * an overlay click. The rest are not the visitor's doing and record nothing.
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
 * **It starts once the page has settled.** When `open` turns true it waits
 * until every step's anchor is visible, or until at least one is and the
 * visible anchors have not changed for 200 ms, or two seconds at most, then
 * shows the steps whose anchor is visible: a step pointing at a control the
 * page does not show (a narrow layout, a closed tab) is dropped rather than
 * pointing at nothing.
 * When no step is left, or another walkthrough is already showing, it calls
 * `onPostpone` instead of starting.
 *
 * Done on the last step, or the right arrow key there, calls `onFinish`; Skip,
 * Escape and a click on the overlay call `onSkip`. Turning `open` false or
 * unmounting closes the popovers without calling either.
 */
const Walkthrough = ({ steps, open, onFinish, onSkip, onPostpone }: WalkthroughProps): null => {
  const readSteps = useEffectEvent(() => steps)
  const handleFinish = useEffectEvent(onFinish)
  const handleSkip = useEffectEvent(onSkip)
  const handlePostpone = useEffectEvent(onPostpone)

  useEffect(() => {
    if (!open) return undefined
    let tour: Driver | undefined
    const stopWaiting = waitForAnchoredSteps(readSteps(), (anchoredSteps) => {
      if (anchoredSteps.length === 0 || showingTour?.isActive() === true) {
        handlePostpone()
        return
      }
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
