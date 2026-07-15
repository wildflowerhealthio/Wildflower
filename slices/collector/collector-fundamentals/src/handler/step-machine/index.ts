/**
 * Step-driver finite state machine, decomposed into its parts:
 *
 * - `./messages.ts`   — input messages (1) & side-effect messages (3)
 * - `./state.ts`      — states (2)
 * - `./side-effect-handlers.ts` — side-effect handlers (4)
 * - `./transition.ts` — the pure transition table (5)
 * - `./make.ts`       — the serialized runtime that ties them together (6)
 *
 * The public surface consumers use is `make` plus the `StepMachine` /
 * `StepOutboundMessage` / `StepState` types; the remaining parts are
 * exported so the pure transition can be exercised in isolation.
 *
 * See the [Handler Explanation](../../../docs/Handler%20Explanation.md) for
 * the FSM rationale — the generation discipline and why `dispatch` isn't
 * `uninterruptible`.
 */

export { InputMessages, SideEffectMessages } from './messages.ts'
export type { InputMessage, SideEffectMessage, StepOutboundMessage } from './messages.ts'
export { make } from './make.ts'
export type { StepMachine } from './make.ts'
export { sideEffectHandlers } from './side-effect-handlers.ts'
export type { StepState } from './state.ts'
export { transition } from './transition.ts'
