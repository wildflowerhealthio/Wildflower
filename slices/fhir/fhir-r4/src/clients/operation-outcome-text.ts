import { Array as Arr, Option, Schema } from 'effect'

/**
 * The parts of an OperationOutcome a person can read: each issue's
 * `diagnostics` and `details.text`.
 *
 * @remarks
 * Looser than `Bundle.OperationOutcomeSchema`, which requires each issue's
 * `severity` and `code`: an error answer is read for its words alone, and a
 * server or proxy that leaves the codes out still said something.
 */
const OperationOutcomeText = Schema.Struct({
  resourceType: Schema.Literal('OperationOutcome'),
  issue: Schema.Array(
    Schema.Struct({
      diagnostics: Schema.optional(Schema.String),
      details: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) })),
    })
  ),
})

const decodeOperationOutcomeText = Schema.decodeUnknownOption(OperationOutcomeText)

/**
 * What the OperationOutcome `body` says, its issues' texts joined with `; `,
 * or `None` when `body` is not an OperationOutcome or says nothing.
 */
const operationOutcomeTextOf = (body: unknown): Option.Option<string> =>
  decodeOperationOutcomeText(body).pipe(
    Option.map(({ issue }) =>
      issue.flatMap((each) =>
        [each.details?.text, each.diagnostics].filter(
          (text): text is string => text !== undefined && text !== ''
        )
      )
    ),
    Option.filter(Arr.isNonEmptyReadonlyArray),
    Option.map(Arr.join('; '))
  )

export { operationOutcomeTextOf }
