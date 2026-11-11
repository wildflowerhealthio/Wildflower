import type {
  BetaTool,
  BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'

import type * as ChatPatient from '../../chat-patient.ts'
import * as PatientPin from '../patient-pin.ts'
import * as RecordAccess from '../record-access.ts'

/**
 * The tools one chat offers, and a call to one of them.
 *
 * @packageDocumentation
 */

/** The tools of one chat, and what they were built from. */
interface Type {
  readonly patient: ChatPatient.Type
  /** The types `search_records` offers, in R4's order; empty when it is not offered. */
  readonly searchableTypes: readonly ResourceType.Type[]
  /** The types `read_record` offers, in R4's order; empty when it is not offered. */
  readonly readableTypes: readonly ResourceType.Type[]
  /** The types `create_record` offers, in R4's order; empty when it is not offered. */
  readonly creatableTypes: readonly ResourceType.Type[]
  /** The types `update_record` offers, in R4's order; empty when it is not offered. */
  readonly updatableTypes: readonly ResourceType.Type[]
  /** The tool definitions every request of the chat sends. */
  readonly definitions: readonly BetaTool[]
}

/** The types `resourceTypes` covers that a chat about `patient` can keep to them. */
const offeredTypesOf = (
  resourceTypes: RecordAccess.ResourceTypes,
  patient: ChatPatient.Type
): readonly ResourceType.Type[] =>
  RecordAccess.typesOf(resourceTypes).filter(
    (resourceType) => patient.kind === 'all-patients' || Option.isSome(PatientPin.of(resourceType))
  )

/** A tool call as a reply makes it. */
type Call = Pick<BetaToolUseBlockParam, 'id' | 'name' | 'input'>

export { offeredTypesOf }
export type { Call, Type }
