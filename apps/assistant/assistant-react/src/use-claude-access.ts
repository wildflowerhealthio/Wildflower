import {
  ApiKey,
  ClaudeModel,
  type ClaudeRequestFailed,
} from '@wildflowerhealthio/assistant-core-js'
import { Effect, Either, Fiber, Option } from 'effect'
import { useCallback, useEffect, useState } from 'react'

import type { AssistantEnvironment } from './assistant-environment.ts'

/**
 * Where the person's access to Claude stands:
 *
 * - `checking-key` — the key is being tried by listing its models;
 * - `needs-key` — there is no key, or the API did not accept the last one;
 * - `models-unavailable` — listing the key's models failed for another reason;
 * - `no-models` — the key can use no Claude model;
 * - `ready` — the key works: its models, and the one chosen.
 */
type ClaudeAccess =
  | { readonly kind: 'checking-key' }
  | { readonly kind: 'needs-key'; readonly keyWasRejected: boolean }
  | {
      readonly kind: 'models-unavailable'
      readonly apiKey: ApiKey.Type
      readonly failure: ClaudeRequestFailed
    }
  | { readonly kind: 'no-models' }
  | {
      readonly kind: 'ready'
      readonly apiKey: ApiKey.Type
      readonly models: readonly ClaudeModel.Type[]
      readonly model: ClaudeModel.Type
      /** Whether the browser kept the key; `false` means it is asked for again next visit. */
      readonly keyKept: boolean
    }

/** A key to try, and whether to keep it once it works (a key just entered) or not (the kept one). */
interface KeyCheck {
  readonly apiKey: ApiKey.Type
  readonly keepOnSuccess: boolean
}

/** {@link useClaudeAccess}'s state and the actions that move it on. */
interface ClaudeAccessControls {
  readonly access: ClaudeAccess
  /** Try the key typed in `input`, keeping it once the API accepts it. Blank input does nothing. */
  readonly saveKey: (input: string) => void
  /** Try the same key again, after `models-unavailable`. */
  readonly retry: () => void
  /** Chat on the listed model `modelId` from now on, and remember it. */
  readonly chooseModel: (modelId: string) => void
  /** Remove the kept key and ask for one again. */
  readonly forgetKey: () => void
  /** The browser refused to remove the key when asked to forget it. */
  readonly forgetFailed: boolean
}

/**
 * The access a key check ends in: `ready` on the chosen (else default)
 * model, `needs-key` when the API rejects the key, `models-unavailable` for
 * any other failure, `no-models` when the key can use none.
 */
const accessAfterCheck = (
  { page, claudeLayerFor }: AssistantEnvironment,
  { apiKey, keepOnSuccess }: KeyCheck
): Effect.Effect<ClaudeAccess> =>
  ClaudeModel.list.pipe(
    Effect.provide(claudeLayerFor(apiKey)),
    Effect.flatMap((models) =>
      Effect.all({
        chosenId: ClaudeModel.readChosenId(page),
        keyKept: keepOnSuccess
          ? ApiKey.write(page, apiKey).pipe(
              Effect.as(true),
              Effect.catchAll((blocked) =>
                Effect.logWarning('The browser would not keep the Claude API key', blocked).pipe(
                  Effect.as(false)
                )
              )
            )
          : Effect.succeed(true),
      }).pipe(
        Effect.map(({ chosenId, keyKept }) =>
          ClaudeModel.startingModelOf(models, chosenId).pipe(
            Option.match({
              onNone: (): ClaudeAccess => ({ kind: 'no-models' }),
              onSome: (model): ClaudeAccess => ({ kind: 'ready', apiKey, models, model, keyKept }),
            })
          )
        )
      )
    ),
    Effect.catchAll((failure) =>
      Effect.succeed<ClaudeAccess>(
        failure.kind === 'key-rejected'
          ? { kind: 'needs-key', keyWasRejected: true }
          : { kind: 'models-unavailable', apiKey, failure }
      )
    )
  )

/**
 * The person's access to Claude, page-logic for `AssistantChat`: the kept
 * key, tried by listing its models on mount; a new key, kept only once the
 * API accepts it; the model chosen among the key's, remembered in
 * `localStorage`; and forgetting the key.
 */
const useClaudeAccess = (environment: AssistantEnvironment): ClaudeAccessControls => {
  const { page } = environment
  const [keyCheck, setKeyCheck] = useState<Option.Option<KeyCheck>>(() =>
    Effect.runSync(ApiKey.read(page)).pipe(
      Option.map((apiKey) => ({ apiKey, keepOnSuccess: false }))
    )
  )
  const [access, setAccess] = useState<ClaudeAccess>(() =>
    Option.isSome(keyCheck)
      ? { kind: 'checking-key' }
      : { kind: 'needs-key', keyWasRejected: false }
  )
  const [forgetFailed, setForgetFailed] = useState(false)

  useEffect(() => {
    if (Option.isNone(keyCheck)) return undefined
    const fiber = Effect.runFork(
      accessAfterCheck(environment, keyCheck.value).pipe(
        Effect.tap((checked) => Effect.sync(() => setAccess(checked)))
      )
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [environment, keyCheck])

  const startCheck = useCallback((check: KeyCheck): void => {
    setAccess({ kind: 'checking-key' })
    setKeyCheck(Option.some(check))
  }, [])

  const saveKey = useCallback(
    (input: string): void => {
      ApiKey.fromInput(input).pipe(
        Option.map((apiKey) => {
          startCheck({ apiKey, keepOnSuccess: true })
        })
      )
    },
    [startCheck]
  )

  const retry = useCallback((): void => {
    if (access.kind === 'models-unavailable')
      startCheck({ apiKey: access.apiKey, keepOnSuccess: false })
  }, [access, startCheck])

  const chooseModel = useCallback(
    (modelId: string): void => {
      if (access.kind !== 'ready') return
      const listed = access.models.find((model) => model.id === modelId)
      if (listed === undefined) return
      setAccess({ ...access, model: listed })
      Effect.runSync(
        ClaudeModel.writeChosenId(page, modelId).pipe(
          Effect.catchAll((blocked) =>
            Effect.logWarning('The browser would not keep the chosen model', blocked)
          )
        )
      )
    },
    [access, page]
  )

  const forgetKey = useCallback((): void => {
    Either.match(Effect.runSync(Effect.either(ApiKey.forget(page))), {
      onLeft: () => {
        setForgetFailed(true)
      },
      onRight: () => {
        setForgetFailed(false)
        setKeyCheck(Option.none())
        setAccess({ kind: 'needs-key', keyWasRejected: false })
      },
    })
  }, [page])

  return { access, saveKey, retry, chooseModel, forgetKey, forgetFailed }
}

export { useClaudeAccess }
export type { ClaudeAccess, ClaudeAccessControls }
