import {
  type ApiKey,
  Chat,
  type ClaudeModel,
  type FhirRecords,
  type RecordAccess,
  Style,
  Turn,
  type WriteProposal,
} from '@wildflowerhealthio/assistant-core-js'
import { Array, DateTime, Effect, Either, Fiber, Layer, Match, Option } from 'effect'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { AssistantEnvironment } from './assistant-environment.ts'

/** The reply being written, as far as it has streamed. */
interface StreamingReply {
  readonly thinking: string
  readonly text: string
}

/**
 * A round of tool calls waiting on the person: the writes it proposes, and
 * the decisions made on them so far, by the id of the call each answers.
 */
interface PendingWrites {
  readonly proposed: Turn.ProposedWrites
  readonly decisions: ReadonlyMap<string, WriteProposal.Decision>
}

/** Why the chat could not be kept: what was kept could not be read, or the browser would not keep it. */
type ChatStorageProblem = 'unreadable' | 'not-kept'

/** {@link useChat}'s state and the actions that move it on. */
interface ChatControls {
  readonly chat: Chat.Type
  /** The reply streaming in; `None` between turns, and while writes wait on the person. */
  readonly streamingReply: Option.Option<StreamingReply>
  /** The round waiting on the person to decide its proposed writes, until the round is kept. */
  readonly pendingWrites: Option.Option<PendingWrites>
  /** A turn is running: a reply is streaming in, or a round's writes wait or are being made. */
  readonly turnRunning: boolean
  /** A proposed write waits on the person's decision; the round's other writes may be decided. */
  readonly writesAwaitingDecision: boolean
  /** Why the last turn failed; `None` once another starts. */
  readonly turnFailure: Option.Option<Turn.Failure>
  readonly storageProblem: Option.Option<ChatStorageProblem>
  /** What the live region says of the last finished reply. */
  readonly announcement: string
  /** The style can no longer change: the chat has a message. */
  readonly styleLocked: boolean
  /** The academic style's confirmation is open. */
  readonly academicConfirmationOpen: boolean
  /** Pick `style` for the chat; academic asks for confirmation first. Nothing once locked. */
  readonly requestStyle: (style: Style.Type) => void
  readonly confirmAcademic: () => void
  readonly cancelAcademic: () => void
  /** Ask `text` on `model` with `apiKey`, streaming the reply in. */
  readonly send: (message: {
    readonly text: string
    readonly model: ClaudeModel.Type
    readonly apiKey: ApiKey.Type
  }) => void
  /**
   * Decide the proposal for the call `callId`; once every proposal of the
   * round is decided, the turn goes on. Nothing once it is decided.
   */
  readonly decideWrite: (callId: string, decision: WriteProposal.Decision) => void
  /** Abort the turn: the reply streaming in, or the wait for decisions. The person's message stays, with no reply. */
  readonly stop: () => void
  /** Drop this chat and start another in the default style. */
  readonly newChat: () => void
}

/** What a chat's tools reach: what the grant allows, and the FHIR server they read. */
interface ChatRecords {
  readonly recordAccess: RecordAccess.Type
  readonly fhirRecordsLayer: Layer.Layer<FhirRecords>
}

/** What the live region says once a turn has kept `entry`. */
const announcementOf = (entry: Chat.Entry): string =>
  Match.value(entry).pipe(
    Match.tag('agent', ({ stopReason }) =>
      stopReason === 'max_tokens' ? 'Claude replied, but the reply was cut off.' : 'Claude replied.'
    ),
    Match.tag('refusal', () => 'Claude declined to answer this.'),
    Match.tag('user', () => ''),
    Match.tag('tool-round', () => ''),
    Match.exhaustive
  )

/**
 * The chat at `place`, page-logic for `AssistantChat`: read from the tab's
 * `sessionStorage` on mount and written back after every entry; the style,
 * chosen before the first message (academic only once confirmed) and
 * locked after it; each turn streamed in, its tool rounds kept as they
 * finish, its proposed writes held for the person to decide, stoppable;
 * and a new chat. The tools reach `records`.
 *
 * @remarks
 * Mount one per place: `AssistantChat` keys it by the chat's storage key,
 * so a new patient starts a new chat. A kept chat that cannot be read
 * starts a new one and says so.
 */
const useChat = (
  { storage, claudeLayerFor }: AssistantEnvironment,
  place: Chat.Place,
  { recordAccess, fhirRecordsLayer }: ChatRecords
): ChatControls => {
  const [initial] = useState(() =>
    Effect.runSync(
      Effect.either(Chat.read(place).pipe(Effect.provide(Layer.provide(Chat.layer, storage))))
    )
  )
  const [chat, setChat] = useState<Chat.Type>(() =>
    Either.match(initial, {
      onLeft: () => Chat.start(Style.DEFAULT),
      onRight: Option.getOrElse(() => Chat.start(Style.DEFAULT)),
    })
  )
  const [storageProblem, setStorageProblem] = useState<Option.Option<ChatStorageProblem>>(() =>
    Either.match(initial, {
      onLeft: (failure): Option.Option<ChatStorageProblem> =>
        Option.some(failure._tag === 'StoredChatUnreadable' ? 'unreadable' : 'not-kept'),
      onRight: () => Option.none(),
    })
  )
  const [streamingReply, setStreamingReply] = useState<Option.Option<StreamingReply>>(Option.none())
  const [pendingWrites, setPendingWrites] = useState<Option.Option<PendingWrites>>(Option.none())
  const [turnFailure, setTurnFailure] = useState<Option.Option<Turn.Failure>>(Option.none())
  const [announcement, setAnnouncement] = useState('')
  const [academicConfirmationOpen, setAcademicConfirmationOpen] = useState(false)
  // The running turn, for Stop and unmount to interrupt, and which turn is
  // current: a turn whose number has moved on (a new chat) changes nothing
  // when it settles. Neither is rendered.
  const turnFiber = useRef<Option.Option<Fiber.RuntimeFiber<unknown>>>(Option.none())
  const currentTurnNumber = useRef(0)
  // How the running turn's wait for decisions resumes, once every proposal
  // is decided. Not rendered.
  const resumeWithDecisions = useRef<
    Option.Option<(decisions: Array.NonEmptyReadonlyArray<WriteProposal.Decision>) => void>
  >(Option.none())

  const interruptTurn = useCallback((): void => {
    Option.map(turnFiber.current, (fiber) => Effect.runFork(Fiber.interrupt(fiber)))
  }, [])

  useEffect(() => interruptTurn, [interruptTurn])

  const keep = useCallback(
    (kept: Chat.Type): void => {
      Either.match(
        Effect.runSync(
          Effect.either(
            Chat.write(place, kept).pipe(Effect.provide(Layer.provide(Chat.layer, storage)))
          )
        ),
        {
          onLeft: () => {
            setStorageProblem(Option.some('not-kept'))
          },
          onRight: () => undefined,
        }
      )
    },
    [storage, place]
  )

  const styleLocked = chat.entries.length > 0
  const turnRunning = Option.isSome(streamingReply) || Option.isSome(pendingWrites)
  const writesAwaitingDecision = Option.exists(pendingWrites, ({ proposed, decisions }) =>
    proposed.proposals.some(({ callId }) => !decisions.has(callId))
  )

  const requestStyle = useCallback(
    (style: Style.Type): void => {
      if (styleLocked) return
      if (style === 'academic') setAcademicConfirmationOpen(true)
      else setChat(Chat.start(style))
    },
    [styleLocked]
  )

  const confirmAcademic = useCallback((): void => {
    setAcademicConfirmationOpen(false)
    if (!styleLocked) setChat(Chat.start('academic'))
  }, [styleLocked])

  const cancelAcademic = useCallback((): void => {
    setAcademicConfirmationOpen(false)
  }, [])

  const send = useCallback<ChatControls['send']>(
    ({ text, model, apiKey }) => {
      if (turnRunning) return
      const asked = Chat.append(chat, Chat.userEntryOf(text))
      setChat(asked)
      keep(asked)
      setTurnFailure(Option.none())
      setAnnouncement('')
      setStreamingReply(Option.some({ thinking: '', text: '' }))
      currentTurnNumber.current += 1
      const turnNumber = currentTurnNumber.current
      const ifCurrent =
        <A extends unknown[]>(update: (...args: A) => void) =>
        (...args: A): void => {
          if (currentTurnNumber.current === turnNumber) update(...args)
        }
      const appendDelta = ifCurrent((delta: Turn.Delta): void => {
        setStreamingReply(
          Option.map((streamed) =>
            delta.kind === 'text'
              ? { ...streamed, text: streamed.text + delta.text }
              : { ...streamed, thinking: streamed.thinking + delta.text }
          )
        )
      })
      // The chat as this turn has kept it so far: each tool round is appended
      // as it finishes, and the answer after the last.
      let kept = asked
      const keepToolRound = ifCurrent((round: Chat.ToolRound) => {
        kept = Chat.append(kept, round)
        setChat(kept)
        keep(kept)
        setPendingWrites(Option.none())
        setStreamingReply(Option.some({ thinking: '', text: '' }))
      })
      const showProposedWrites = ifCurrent((proposed: Turn.ProposedWrites) => {
        setStreamingReply(Option.none())
        setPendingWrites(Option.some({ proposed, decisions: new Map() }))
      })
      // The turn waits here until every proposal is decided (decideWrite) or
      // the turn is interrupted (Stop, New chat, unmount).
      const confirmWrites: Turn.Report['confirmWrites'] = (proposed) =>
        Effect.async<Array.NonEmptyReadonlyArray<WriteProposal.Decision>>((resume) => {
          resumeWithDecisions.current = Option.some((decisions) => {
            resumeWithDecisions.current = Option.none()
            resume(Effect.succeed(decisions))
          })
          showProposedWrites(proposed)
          return Effect.sync(() => {
            resumeWithDecisions.current = Option.none()
          })
        })
      turnFiber.current = Option.some(
        Effect.runFork(
          Turn.run(
            { chat: asked, model, patient: place.patient, recordAccess },
            { delta: appendDelta, toolRound: keepToolRound, confirmWrites }
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                claudeLayerFor(apiKey),
                fhirRecordsLayer,
                DateTime.layerCurrentZoneLocal
              )
            ),
            Effect.match({
              onSuccess: ifCurrent((entry: Chat.Entry) => {
                const answered = Chat.append(kept, entry)
                setChat(answered)
                keep(answered)
                setAnnouncement(announcementOf(entry))
              }),
              onFailure: ifCurrent((failure: Turn.Failure) => {
                setTurnFailure(Option.some(failure))
              }),
            }),
            Effect.ensuring(
              Effect.sync(
                ifCurrent(() => {
                  setStreamingReply(Option.none())
                  setPendingWrites(Option.none())
                  turnFiber.current = Option.none()
                })
              )
            )
          )
        )
      )
    },
    [chat, claudeLayerFor, fhirRecordsLayer, keep, place.patient, recordAccess, turnRunning]
  )

  const decideWrite = useCallback<ChatControls['decideWrite']>(
    (callId, decision) => {
      Option.map(pendingWrites, ({ proposed, decisions }) => {
        if (decisions.has(callId)) return
        const decided = new Map(decisions).set(callId, decision)
        setPendingWrites(Option.some({ proposed, decisions: decided }))
        Option.all(
          Array.map(proposed.proposals, (proposal) =>
            Option.fromNullable(decided.get(proposal.callId))
          )
        ).pipe(
          Option.filter(Array.isNonEmptyReadonlyArray),
          Option.flatMap((allDecided) =>
            Option.map(resumeWithDecisions.current, (resume) => {
              resume(allDecided)
            })
          )
        )
      })
    },
    [pendingWrites]
  )

  const newChat = useCallback((): void => {
    interruptTurn()
    turnFiber.current = Option.none()
    currentTurnNumber.current += 1
    Either.match(
      Effect.runSync(
        Effect.either(Chat.forget(place).pipe(Effect.provide(Layer.provide(Chat.layer, storage))))
      ),
      {
        onLeft: () => {
          setStorageProblem(Option.some('not-kept'))
        },
        onRight: () => {
          setStorageProblem(Option.none())
        },
      }
    )
    setChat(Chat.start(Style.DEFAULT))
    setStreamingReply(Option.none())
    setPendingWrites(Option.none())
    setTurnFailure(Option.none())
    setAnnouncement('')
  }, [interruptTurn, storage, place])

  return {
    chat,
    streamingReply,
    pendingWrites,
    turnRunning,
    writesAwaitingDecision,
    turnFailure,
    storageProblem,
    announcement,
    styleLocked,
    academicConfirmationOpen,
    requestStyle,
    confirmAcademic,
    cancelAcademic,
    send,
    decideWrite,
    stop: interruptTurn,
    newChat,
  }
}

export { useChat }
export type { ChatControls, ChatRecords, ChatStorageProblem, PendingWrites, StreamingReply }
