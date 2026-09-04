/*
 * Image URLs served from the project's GitHub Pages asset bucket
 * (`wildflowerhealthio.github.io/assets/marketing-site/...`). They are still
 * remote — routing every `<img src>` through this module keeps swapping to
 * committed local assets a one-file change.
 *
 * The portrait must stay a PNG with alpha — its bottom fade relies on
 * transparency plus a CSS mask.
 */

const ASSET_BASE = 'https://wildflowerhealthio.github.io/assets/marketing-site'

/** Portrait for the "I'm Ruth" intro: cut-out on transparent, bottom-faded via mask. */
const portraitImage = {
  src: `${ASSET_BASE}/photos/ruth_marks_headshot_full_alpha.png`,
  alt: 'Ruth Marks',
}

/** The four SMART on FHIR consent-flow iPhone screenshots, in step order. */
const stepImages = [
  {
    src: `${ASSET_BASE}/apple-fhir/apple_fhir_setup_1.png`,
    alt: 'Selecting a health provider',
  },
  {
    src: `${ASSET_BASE}/apple-fhir/apple_fhir_setup_2.png`,
    alt: 'Logging in with your patient portal account',
  },
  {
    src: `${ASSET_BASE}/apple-fhir/apple_fhir_setup_3.png`,
    alt: 'Choosing what to share, and for how long',
  },
  {
    src: `${ASSET_BASE}/apple-fhir/apple_fhir_setup_4.png`,
    alt: 'Accessing your data from the app',
  },
] as const

/** Home screen of the Medication Viewer, showing its interactions panel. */
const medicationsHomeImage = {
  src: `${ASSET_BASE}/medications-app/interactions_home.png`,
  alt: 'Medication Viewer home screen, showing prescription interactions',
}

export { medicationsHomeImage, portraitImage, stepImages }
