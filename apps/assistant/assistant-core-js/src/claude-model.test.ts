import { AuthenticationError } from '@anthropic-ai/sdk'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime, Effect, Either, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as ClaudeModel from './claude-model.ts'
import { ClaudeRequestFailed } from './claude.ts'
import { blockedStoragePage, memoryStoragePage, modelInfoOf, stubClaude } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

/** A model, as decoded, with a distinct release instant per id. */
const modelArb: fc.Arbitrary<ClaudeModel.Type> = fc.record({
  id: fc.oneof(
    fc.string().map((tail) => `claude-${tail}`),
    fc.string()
  ),
  displayName: fc.string(),
  createdAt: fc
    .integer({ min: 0, max: 4_000_000_000_000 })
    .map((millis) => DateTime.unsafeMake(millis)),
  supportsAdaptiveThinking: fc.boolean(),
  maxTokens: fc.constantFrom(null, 32_000, 64_000),
  lifecycle: fc.constant('active'),
})

const model = (id: string, createdAt = '2026-01-01T00:00:00Z'): ClaudeModel.Type => ({
  id,
  displayName: id,
  createdAt: DateTime.unsafeMake(createdAt),
  supportsAdaptiveThinking: true,
  maxTokens: 64_000,
  lifecycle: 'active',
})

describe('ClaudeModel.choicesOf', () => {
  it('should keep exactly the claude- models, newest first', () => {
    fc.assert(
      fc.property(fc.uniqueArray(modelArb, { selector: ({ id }) => id }), (models) => {
        const choices = ClaudeModel.choicesOf(models)

        const byId = (a: ClaudeModel.Type, b: ClaudeModel.Type): number => a.id.localeCompare(b.id)
        expect(choices.toSorted(byId)).toEqual(
          models.filter(({ id }) => id.startsWith('claude-')).toSorted(byId)
        )
        choices.slice(1).forEach((later, index) => {
          expect(DateTime.lessThanOrEqualTo(later.createdAt, choices[index].createdAt)).toBe(true)
        })
      }),
      { numRuns: RUNS }
    )
  })
})

describe('ClaudeModel.startingModelOf', () => {
  const models = [model('claude-opus-5'), model(ClaudeModel.DEFAULT_ID), model('claude-haiku-5')]

  it('should start on the chosen model while it is listed', () => {
    expect(ClaudeModel.startingModelOf(models, Option.some('claude-haiku-5'))).toEqual(
      Option.some(models[2])
    )
  })

  it('should start on Sonnet 5 when nothing listed was chosen', () => {
    expect(ClaudeModel.startingModelOf(models, Option.none())).toEqual(Option.some(models[1]))
    expect(ClaudeModel.startingModelOf(models, Option.some('claude-retired-1'))).toEqual(
      Option.some(models[1])
    )
  })

  it('should start on the first listed model when Sonnet 5 is not listed', () => {
    expect(ClaudeModel.startingModelOf([models[0], models[2]], Option.none())).toEqual(
      Option.some(models[0])
    )
  })

  it('should choose nothing from no models', () => {
    expect(ClaudeModel.startingModelOf([], Option.some(ClaudeModel.DEFAULT_ID))).toEqual(
      Option.none()
    )
  })
})

describe('ClaudeModel.list', () => {
  it('should decode the listing into the claude- models, newest first, with adaptive thinking as the capabilities say', async () => {
    const { layer } = stubClaude({
      models: [
        modelInfoOf({
          id: 'claude-sonnet-5',
          displayName: 'Claude Sonnet 5',
          createdAt: '2026-05-01T00:00:00Z',
        }),
        modelInfoOf({
          id: 'claude-haiku-4-5',
          createdAt: '2025-10-01T00:00:00Z',
          supportsAdaptiveThinking: false,
        }),
        modelInfoOf({
          id: 'claude-old',
          createdAt: '2024-01-01T00:00:00Z',
          supportsAdaptiveThinking: null,
        }),
        modelInfoOf({ id: 'not-claude', createdAt: '2026-09-01T00:00:00Z' }),
        modelInfoOf({
          id: 'claude-retired',
          createdAt: '2026-10-01T00:00:00Z',
          lifecycle: 'retired',
        }),
        modelInfoOf({ id: 'claude-opus-5', createdAt: '2026-08-01T00:00:00Z' }),
      ],
    })

    const listed = await Effect.runPromise(ClaudeModel.list.pipe(Effect.provide(layer)))

    expect(listed).toEqual([
      {
        id: 'claude-opus-5',
        displayName: 'claude-opus-5',
        createdAt: DateTime.unsafeMake('2026-08-01T00:00:00Z'),
        supportsAdaptiveThinking: true,
        maxTokens: 64_000,
        lifecycle: 'active',
      },
      {
        id: 'claude-sonnet-5',
        displayName: 'Claude Sonnet 5',
        createdAt: DateTime.unsafeMake('2026-05-01T00:00:00Z'),
        supportsAdaptiveThinking: true,
        maxTokens: 64_000,
        lifecycle: 'active',
      },
      {
        id: 'claude-haiku-4-5',
        displayName: 'claude-haiku-4-5',
        createdAt: DateTime.unsafeMake('2025-10-01T00:00:00Z'),
        supportsAdaptiveThinking: false,
        maxTokens: 64_000,
        lifecycle: 'active',
      },
      {
        id: 'claude-old',
        displayName: 'claude-old',
        createdAt: DateTime.unsafeMake('2024-01-01T00:00:00Z'),
        supportsAdaptiveThinking: false,
        maxTokens: 64_000,
        lifecycle: 'active',
      },
    ])
  })

  it('should fail as key-rejected when the API does not accept the key', async () => {
    const { layer } = stubClaude({
      modelsThrow: new AuthenticationError(401, undefined, 'invalid x-api-key', new Headers()),
    })

    const failure = await Effect.runPromise(
      Effect.flip(ClaudeModel.list.pipe(Effect.provide(layer)))
    )

    expect(failure).toEqual(ClaudeRequestFailed.make({ kind: 'key-rejected', status: 401 }))
  })

  it("should fail when a model's capabilities are not the SDK's", async () => {
    const { layer } = stubClaude({
      models: [
        {
          id: 'claude-x',
          display_name: 'Claude X',
          created_at: '2026-01-01T00:00:00Z',
          capabilities: { thinking: 'yes' },
        },
      ],
    })

    const failure = await Effect.runPromise(
      Effect.flip(ClaudeModel.list.pipe(Effect.provide(layer)))
    )

    expect(failure).toEqual(
      ClaudeRequestFailed.make({ kind: 'model-list-unreadable', status: null })
    )
  })

  it('should fail with no status when the listing is not models', async () => {
    const { layer } = stubClaude({ models: [{ id: 'claude-x' }] })

    const failure = await Effect.runPromise(
      Effect.flip(ClaudeModel.list.pipe(Effect.provide(layer)))
    )

    expect(failure).toEqual(
      ClaudeRequestFailed.make({ kind: 'model-list-unreadable', status: null })
    )
  })
})

describe('ClaudeModel chosen id', () => {
  it('should read back the id it wrote', () => {
    fc.assert(
      fc.property(fc.string(), (modelId) => {
        const page = memoryStoragePage()

        Effect.runSync(ClaudeModel.writeChosenId(page, modelId))

        expect(Effect.runSync(ClaudeModel.readChosenId(page))).toEqual(Option.some(modelId))
      }),
      { numRuns: RUNS }
    )
  })

  it('should fail the read when the browser refuses the read or the storage itself', () => {
    const refusingRead = memoryStoragePage(['getItem'])
    refusingRead.localStorage.items.set(ClaudeModel.CHOSEN_ID_STORAGE_KEY, 'claude-opus-5')

    expect(
      Either.isLeft(Effect.runSync(Effect.either(ClaudeModel.readChosenId(refusingRead))))
    ).toBe(true)
    expect(
      Either.isLeft(Effect.runSync(Effect.either(ClaudeModel.readChosenId(blockedStoragePage()))))
    ).toBe(true)
  })

  it('should fail naming the write when the browser refuses it', () => {
    const failure = Effect.runSync(
      Effect.flip(ClaudeModel.writeChosenId(memoryStoragePage(['setItem']), 'claude-opus-5'))
    )

    expect(failure).toMatchObject({ _tag: 'StorageBlocked', operation: 'write' })
  })
})
