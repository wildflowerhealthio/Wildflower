/*
 * TEMPORARY remote image URLs.
 *
 * The design handoff hosts these five images on a free image host that will
 * not survive long-term; they are meant to be committed into the repo and
 * served locally (the portrait must stay a PNG with alpha — its bottom fade
 * relies on transparency plus a CSS mask). Where to store them is still being
 * decided, so for now every `<img src>` routes through this module — swapping
 * to committed assets is a one-file change.
 */

/** Hero portrait: cut-out on a transparent background, bottom-faded via mask. */
const portraitImage = { src: 'https://s6.imgcdn.dev/Y8TSXd.png', alt: 'Ruth Marks' }

/** The four SMART on FHIR consent-flow iPhone screenshots, in step order. */
const stepImages = [
  { src: 'https://s6.imgcdn.dev/Y8TTB2.png', alt: 'Selecting a health provider' },
  { src: 'https://s6.imgcdn.dev/Y8T5Xy.png', alt: 'Logging in with your patient portal account' },
  { src: 'https://s6.imgcdn.dev/Y8TPI8.png', alt: 'Choosing what to share, and for how long' },
  { src: 'https://s6.imgcdn.dev/Y8Ty29.png', alt: 'Accessing your data from the app' },
] as const

export { portraitImage, stepImages }
