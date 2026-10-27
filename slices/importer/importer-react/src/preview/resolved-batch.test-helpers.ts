/**
 * A resolved batch for the tests of what reads one (the server diff, the
 * preview panel), which feed it hand-built batches rather than run
 * `resolveMentions` over them.
 *
 * @packageDocumentation
 */

import type { DecodedBatch, ResolvedBatch } from '@wildflowerhealthio/importer-core'
import { Brand } from 'effect'

/** `batch` taken as resolved as it stands: its mentions are not what the test is about. */
const resolvedAsIs: (batch: DecodedBatch) => ResolvedBatch = Brand.nominal<ResolvedBatch>()

export { resolvedAsIs }
