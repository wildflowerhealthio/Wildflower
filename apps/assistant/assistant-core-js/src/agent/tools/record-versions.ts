import { Match, Option, Schema } from 'effect'

import * as Chat from '../../chat.ts'
import { decodePageResult } from './page.ts'
import { ReadRecordResult } from './read-record.ts'
import {
  CREATE_RECORD,
  NEXT_PAGE,
  READ_RECORD,
  SEARCH_RECORDS,
  UPDATE_RECORD,
} from './tool-names.ts'
import { WriteRecordResult } from './write-record.ts'

/**
 * The version of each record a chat has read or written, which an update
 * is made against.
 *
 * @packageDocumentation
 */

/** A record as far as its version is read: its type, its id and its `meta.versionId`. */
const VersionedRecord = Schema.Struct({
  resourceType: Schema.String,
  id: Schema.String,
  meta: Schema.Struct({ versionId: Schema.String }),
})

const decodeVersionedRecord = Schema.decodeUnknownOption(VersionedRecord)
const decodeReadRecordResult = Schema.decodeUnknownOption(ReadRecordResult)
const decodeWriteRecordResult = Schema.decodeUnknownOption(WriteRecordResult)

/** The records the result `content` of a call to `toolName` holds; none for a tool that holds none. */
const recordsInResultOf = (toolName: string, content: unknown): readonly unknown[] =>
  Match.value(toolName).pipe(
    Match.when(READ_RECORD, () => Option.toArray(decodeReadRecordResult(content))),
    Match.whenOr(SEARCH_RECORDS, NEXT_PAGE, () =>
      decodePageResult(content).pipe(
        Option.map(({ resources }) => resources),
        Option.getOrElse((): readonly unknown[] => [])
      )
    ),
    Match.whenOr(CREATE_RECORD, UPDATE_RECORD, () =>
      decodeWriteRecordResult(content).pipe(
        Option.map(({ record }) => [record]),
        Option.getOrElse((): readonly unknown[] => [])
      )
    ),
    Match.orElse(() => [])
  )

/**
 * The version of each record the chat has read or written so far, by its
 * `Type/id`: every record a successful `read_record`, `search_records`,
 * `next_page`, `create_record` or `update_record` result in `chat` holds,
 * the latest seen of each. A record the server keeps no version of is not
 * in it, since it can't be updated against one.
 */
const versionsReadIn = (chat: Chat.Type): ReadonlyMap<string, string> =>
  new Map(
    chat.entries.flatMap((entry) => {
      if (entry._tag !== 'tool-round') return []
      const toolNameById = new Map(
        Chat.toolCallsOf(entry.message).map(({ id, name }) => [id, name] as const)
      )
      return entry.results.flatMap(({ tool_use_id, is_error, content }) =>
        is_error === true
          ? []
          : recordsInResultOf(toolNameById.get(tool_use_id) ?? '', content).flatMap((record) =>
              decodeVersionedRecord(record).pipe(
                Option.map(
                  ({ resourceType, id, meta }) => [`${resourceType}/${id}`, meta.versionId] as const
                ),
                Option.toArray
              )
            )
      )
    })
  )

/** The version `record` (a record read back) is at, if it says. */
const versionIdOf = (record: unknown): Option.Option<string> =>
  decodeVersionedRecord(record).pipe(Option.map(({ meta }) => meta.versionId))

export { versionIdOf, versionsReadIn }
