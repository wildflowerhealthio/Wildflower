/*
 * Image URLs served from the project's GitHub Pages asset bucket
 * (`wildflowerhealthio.github.io/assets/marketing-site/...`). They are still
 * remote — routing every `<img src>` through this module keeps swapping to
 * committed local assets a one-file change.
 */

const ASSET_BASE = 'https://wildflowerhealthio.github.io/assets/marketing-site'

/** The nine "other apps" screenshots the hero's phone frame cycles through. */
const otherAppImages = Array.from({ length: 9 }, (_, index) => ({
  src: `${ASSET_BASE}/other-apps/other_app_${index + 1}.png`,
  alt: `Another patient portal or health app, screen ${index + 1} of 9`,
})) as readonly { readonly src: string; readonly alt: string }[]

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

/** The two Wildflower FHIR server screenshots, in display order. */
const wildflowerServerImages = [
  {
    src: `${ASSET_BASE}/wildflower/app_home.png`,
    alt: 'Wildflower personal FHIR server — home screen',
  },
  {
    src: `${ASSET_BASE}/wildflower/app_authorization.png`,
    alt: 'Wildflower personal FHIR server — SMART app authorization prompt',
  },
] as const

export { medicationsHomeImage, otherAppImages, stepImages, wildflowerServerImages }
