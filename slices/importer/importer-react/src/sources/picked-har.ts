/**
 * The one value every source converges on: a HAR the importer can replay, plus
 * where it came from.
 *
 * @remarks
 * Three inputs feed the picker — a file dropped on the zone, a file chosen
 * through the OS picker, and a HAR archive already uploaded to the device's own
 * FHIR server — and they differ only in {@link PickedHarSource}. The `text` and
 * `fileName` are the same shape whichever path produced them, so a downstream
 * step (2D links the provenance, a replay parses the text) reads one type and
 * never branches on the origin except to read the server reference.
 *
 * @packageDocumentation
 */

/**
 * Where a {@link PickedHar} came from.
 *
 * @remarks
 * A `local` pick is a file that never touched the server — the importer will
 * upload it if the user asks. A `server` pick is a HAR archive
 * `DocumentReference` already on the device, and `reference` is its
 * `DocumentReference/<id>` so a later step can link provenance to the stored
 * archive rather than uploading the same bytes a second time.
 */
type PickedHarSource =
  | { readonly _tag: 'local' }
  | { readonly _tag: 'server'; readonly reference: string }

/** A HAR chosen from one of the picker's three sources, ready to hand on. */
interface PickedHar {
  /** The file's name, for display and for an eventual upload's title. */
  readonly fileName: string
  /** The HAR file's text, decoded from whatever bytes the source held. */
  readonly text: string
  /** Which source produced this pick. */
  readonly source: PickedHarSource
}

/** A `local` source — a file the device holds and the server has never seen. */
const LOCAL_SOURCE: PickedHarSource = { _tag: 'local' }

/**
 * The `DocumentReference/<id>` reference for a HAR archive by logical id.
 *
 * @param id - The archive `DocumentReference`'s logical id
 * @returns The literal FHIR reference string, `DocumentReference/<id>`
 *
 * @remarks
 * Spelled in one place so the `server` source, the `meta.source` stamp a confirm
 * writes for a freshly-uploaded local archive, and any consumer that resolves the
 * reference back to an id all agree on the form. A `server` pick already carries
 * this reference; a `local` pick has none until its bytes are uploaded, at which
 * point the confirm step mints the archive's id and turns it into a reference the
 * same way here.
 */
const harArchiveReference = (id: string): string => `DocumentReference/${id}`

/**
 * The `server` {@link PickedHarSource} for a server-held archive by id.
 *
 * @param id - The archive `DocumentReference`'s logical id
 * @returns A `server` source carrying its {@link harArchiveReference}
 */
const serverSource = (id: string): PickedHarSource => ({
  _tag: 'server',
  reference: harArchiveReference(id),
})

export { harArchiveReference, LOCAL_SOURCE, type PickedHar, type PickedHarSource, serverSource }
