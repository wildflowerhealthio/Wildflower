import { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { describe, expect, it } from 'vite-plus/test'

import { stubFhirRecords } from '../../test-helpers.ts'
import {
  ada,
  everyone,
  accessOf,
  toolsFor,
  namesOf,
  runCall,
  failed,
} from './tools.test-helpers.ts'

describe('Tools.make', () => {
  it('should offer every tool over every R4 type for every patient under system/*.cruds, and none that deletes', () => {
    const tools = toolsFor(everyone)

    expect(namesOf(tools)).toEqual([
      'search_records',
      'next_page',
      'capabilities',
      'read_record',
      'create_record',
      'update_record',
    ])
    expect(tools.searchableTypes).toEqual(ResourceType.VALUES)
    expect(tools.readableTypes).toEqual(ResourceType.VALUES)
    expect(tools.creatableTypes).toEqual(ResourceType.VALUES)
    expect(tools.updatableTypes).toEqual(ResourceType.VALUES)
  })

  it('should offer no delete tool under any grant', () => {
    for (const scope of ['system/*.cruds', 'system/*.d', 'user/Observation.cruds', 'patient/*.*']) {
      expect(
        namesOf(toolsFor(everyone, accessOf(scope))).filter((name) => /delete/u.test(name))
      ).toEqual([])
    }
    expect(namesOf(toolsFor(everyone, accessOf('system/*.d')))).toEqual([])
  })

  it('should offer the write tools only for the types the grant can create or update', () => {
    const tools = toolsFor(everyone, accessOf('patient/Observation.c', 'patient/Condition.u'))

    expect(namesOf(tools)).toEqual(['create_record', 'update_record'])
    expect(tools.creatableTypes).toEqual(['Observation'])
    expect(tools.updatableTypes).toEqual(['Condition'])
    expect(tools.definitions[0]).toMatchObject({
      input_schema: {
        properties: {
          resource: { properties: { resourceType: { enum: ['Observation'] } } },
        },
      },
    })
  })

  it('should not offer to create a Patient in a chat about one, but should to update theirs', () => {
    expect(toolsFor(ada).creatableTypes).not.toContain('Patient')
    expect(toolsFor(ada).creatableTypes).toContain('Observation')
    expect(toolsFor(ada).updatableTypes).toContain('Patient')
    expect(toolsFor(everyone).creatableTypes).toContain('Patient')
  })

  it('should offer fewer tools and types under a narrower grant', () => {
    expect(namesOf(toolsFor(everyone, accessOf('patient/Observation.r')))).toEqual(['read_record'])
    expect(toolsFor(everyone, accessOf('patient/Observation.rs')).searchableTypes).toEqual([
      'Observation',
    ])
    expect(namesOf(toolsFor(everyone, accessOf('patient/Observation.s')))).toEqual([
      'search_records',
      'next_page',
      'capabilities',
    ])
    expect(namesOf(toolsFor(everyone, accessOf('openid', 'patient/*.d')))).toEqual([])
  })

  it('should offer only the types it can keep to one patient in a chat about one', () => {
    const tools = toolsFor(ada)

    expect(tools.searchableTypes).toContain('Observation')
    expect(tools.searchableTypes).toContain('Patient')
    expect(tools.searchableTypes).toContain('Practitioner')
    expect(tools.searchableTypes).not.toContain('Group')
    expect(tools.searchableTypes).not.toContain('Schedule')
    expect(tools.searchableTypes.length).toBeLessThan(ResourceType.VALUES.length)
  })

  it('should define strict tools whose objects allow no other properties', () => {
    const tools = toolsFor(ada, accessOf('patient/Observation.rs'))
    const withoutDescriptions: unknown = JSON.parse(
      JSON.stringify(tools.definitions, (key, value: unknown) =>
        key === 'description' ? undefined : value
      )
    )

    expect(tools.definitions[0]?.description).toContain('keeps every search to their records')
    expect(tools.definitions[3]?.description).toContain('about another patient')
    expect(withoutDescriptions).toEqual([
      {
        name: 'search_records',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            resourceType: {
              type: 'string',
              enum: ['Observation'],
            },
            params: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['name', 'value'],
                additionalProperties: false,
              },
            },
          },
          required: ['resourceType', 'params'],
          additionalProperties: false,
        },
      },
      {
        name: 'next_page',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { cursor: { type: 'string' } },
          required: ['cursor'],
          additionalProperties: false,
        },
      },
      {
        name: 'capabilities',
        strict: true,
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      {
        name: 'read_record',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            resourceType: {
              type: 'string',
              enum: ['Observation'],
            },
            id: { type: 'string' },
          },
          required: ['resourceType', 'id'],
          additionalProperties: false,
        },
      },
    ])
  })
})

describe('Tools.run for a tool the chat lacks', () => {
  it('should fail the call, naming the tool', () => {
    expect(
      runCall(toolsFor(everyone, accessOf('openid')), stubFhirRecords({}), 'search_records', {})
    ).toEqual(failed('There is no tool called search_records.'))
  })
})
