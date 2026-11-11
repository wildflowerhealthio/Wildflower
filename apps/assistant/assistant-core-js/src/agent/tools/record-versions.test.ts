import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as Chat from '../../chat.ts'
import { toolUseBlock } from '../../test-helpers.ts'
import * as Tools from './index.ts'
import { chatHavingRead, storedWeight } from './tools.test-helpers.ts'

describe('Tools.versionsReadIn', () => {
  it('should hold the latest version of each record read, searched or written, and none from failed calls', () => {
    const searched = { ...storedWeight, id: 'o2', meta: { versionId: '7' } }
    const chat = Chat.append(chatHavingRead(storedWeight, { resourceType: 'Patient', id: 'p1' }), {
      _tag: 'tool-round',
      modelId: 'claude-sonnet-5',
      message: {
        role: 'assistant',
        content: [
          toolUseBlock('search', 'search_records', {}),
          toolUseBlock('update', 'update_record', {}),
          toolUseBlock('failed', 'read_record', {}),
        ],
      },
      results: [
        {
          type: 'tool_result',
          tool_use_id: 'search',
          content: JSON.stringify({ resources: [searched], more: false }),
        },
        {
          type: 'tool_result',
          tool_use_id: 'update',
          content: Schema.encodeSync(Tools.WriteRecordResult)({
            resourceType: 'Observation',
            id: 'o1',
            versionId: '4',
            record: { ...storedWeight, meta: { versionId: '4' } },
          }),
        },
        {
          type: 'tool_result',
          tool_use_id: 'failed',
          is_error: true,
          content: JSON.stringify({ ...storedWeight, id: 'o3' }),
        },
      ],
    })

    expect(Tools.versionsReadIn(chat)).toEqual(
      new Map([
        ['Observation/o1', '4'],
        ['Observation/o2', '7'],
      ])
    )
  })
})
