/**
 * The cross-source specificity tiers a `tryRecognize` claim scores against —
 * routing is highest-wins (`Extraction.routeTo`). A plain, ordered convention
 * rather than an enum this package polices (a new kind of source needs no
 * change here), with room between tiers so a future source slots in without
 * renumbering.
 */
const Specificity = {
  /** A named patient portal — never mistaken for a bare protocol server. */
  PORTAL: 100,
  /** Any server speaking a known protocol (a bare FHIR R4 server). */
  PROTOCOL: 50,
  /** A recorder that claims everything — wins only when nothing else does. */
  CATCH_ALL: 0,
} as const

export { Specificity }
