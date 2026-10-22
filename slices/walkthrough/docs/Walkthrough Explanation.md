# Walkthrough Explanation

How a Wildflower app shows a first-run walkthrough: popovers that point at the page's own controls, which the visitor can step through or skip, and which do not show again once they have done either.

The record of a visitor having been through a walkthrough is a pure model in `walkthrough-core` (`seen-walkthrough.ts`), beside the step type and the anchor attribute (`walkthrough-step.ts`). `walkthrough-react` shows it: `useWalkthrough` reads and writes the record, and `Walkthrough` draws the popovers with [driver.js](https://driverjs.com). Apps never import driver.js themselves.

## Steps point at anchors

A walkthrough is a list of steps, each a title, a body and an anchor. The anchor is the value of a `data-walkthrough` attribute on the control the step points at, which the app sets by spreading `walkthroughAnchor('<anchor>')` onto it. Steps find their controls by this attribute rather than by class or element, so restyling or restructuring a page does not break them, and the page's markup says which controls a walkthrough uses.

The title and body are plain text.

## Only rendered anchors get a step

When a walkthrough opens, `Walkthrough` waits for every step's anchor to be rendered, for up to two seconds, so a page still loading its data does not start with steps missing. It then keeps the steps whose anchor is on the page and takes up space, and drops the rest: a control the current layout hides (a narrow screen, a closed tab, a section not yet shown) gets no popover pointing at nothing. The step counter counts the steps kept.

If no step is left, the walkthrough does not start, and nothing is recorded, so it opens again next time.

## Finishing or skipping is remembered

Each popover has Skip, Back and Next, with Done in place of Next on the last step, and a step counter. Done records the walkthrough as finished. Skip, Escape and a click on the overlay record it as skipped. Closing it any other way, such as the page unmounting it, records nothing.

The record is one versioned entry in `localStorage` per walkthrough, under `wildflower.walkthrough.<id>`: the version of the steps the visitor saw, whether they finished or skipped, and when. Storage is per origin and every app has its own, so ids only need to be unique within an app. A record whose version is not the walkthrough's current one reads as unseen, as does a record that does not decode: raising a walkthrough's version shows the updated steps to everyone again, and a corrupt record is replaced by the next outcome.

`useWalkthrough` reads the record once, on mount, and opens the walkthrough when there is none for the current version. Its `reopen` shows the walkthrough again over a record, for an app's "Show walkthrough again" entry; the next outcome replaces the record.

## It looks like the rest of the app

`Walkthrough` keeps driver.js's own stylesheet for positioning the popover, the overlay and the arrow, and restyles the popover with react-tundraish's colour tokens through `walkthrough.module.css`: the raised popover surface, the accent for Next and Done, and the dialog's scrim for the overlay, all of which follow the light and dark schemes. While a walkthrough shows, the highlighted control does not respond to clicks, so a click cannot navigate away mid-walkthrough.
