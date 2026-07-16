# Handler Explanation

How `src/handler/` turns the raw sniffer-event stream flowing back from the
Tauri host into parsed resources and scripted navigation. Read the
[Bridge Explanation](../../../../docs/Messaging/Bridge%20Explanation.md)
first for the webview↔host channel these handlers sit on, and
[scraping-plan.ts](../src/model/scraping-plan.ts) for the per-slice
configuration they consume. For how these handlers sit inside the whole
"Import Now" pipeline (config → registry dispatch → drive loop → persist),
see the [Collector Sync Explanation](./Collector%20Sync%20Explanation.md).

## Two machines, one surface

`CollectorBridgeMessageHandler.make` ([collector-bridge-message-handler.ts](../src/handler/collector-bridge-message-handler.ts))
composes **two independent machines** into the single handler record the
bridge dispatches inbound messages to:

- The **response tracker** ([response-tracker.ts](../src/handler/response-tracker.ts))
  owns the five response events (`ResponseStart` / `ResponseData` /
  `ResponseFinished` / `RequestError` / `Cancelled`) and the
  `inProgressResponses` map.
- The **step machine** ([step-machine/](../src/handler/step-machine/)) owns
  `PageLoaded` and drives the scripted `stepSequence` through settle-timer
  and URL-match-timeout daemons.

They share **no state**. Their only channel to each other is the supplied
`sendMessage` — both ask the host to send outbound messages, but neither
reads the other's internals. The composition function threads the shared
inputs (`scrapingPlan`, `sendMessage`, `onResult`) into both and folds
their `clear` / `cancelAllInFlight` contributions together, **step machine
first** (interrupt its timer fibers) then the response tracker (drop /
cancel tracked responses). This order is **not** load-bearing: the two
machines share no state and the step machine's only side effect is
`sendMessage` (it never touches `inProgressResponses`), so a step firing
mid-teardown cannot reach a half-torn-down tracker. The sequence is
preserved from the pre-split handler purely so the externally visible
order of outbound messages is byte-for-byte unchanged.

Keeping them separate is a deliberate shape choice: the response tracker is
a keyed collection of independent per-id accumulators, not an automaton, so
it is _not_ modelled as a state machine even though the step machine is.
Forcing a transition table onto it would add ceremony (a state per id) for
no benefit.

## Response tracker: the offer-then-drop invariant

Every terminal path — `ResponseFinished` (parsed), `RequestError`,
`Cancelled`, and a base64 decode failure inside `ResponseData` — does the
same two things in the same order: **offer** the terminal `onResult`, then
**drop** the tracked id. This is the `settleAndRemove` helper, and the
order is load-bearing.

A consumer decides a sync run is quiescent by observing three things at
once: sniffing is done, its mailbox is empty, and there are no tracked
responses. If a handler dropped the id _before_ offering the result, that
check could observe a momentary "settled" state — id already gone, event
not yet queued — and terminate the run while the write is still pending,
losing the resource. Offering first guarantees the consumer always sees
_either_ the tracked id _or_ the queued event, never a gap between them.
The parse in `ResponseFinished` is span-wrapped and latency-bearing, which
is exactly the window that would be exposed by the wrong order.

Two supporting invariants:

- **Entity pinned at `ResponseStart`.** The matching `EntityDefinition` is
  resolved once, when the stream starts, and stored on the tracked entry.
  Later events never re-walk `entityDefinitions`, so a redirected
  `RequestError.url` (or any mid-stream change) can't reroute parsing. The
  `url` captured at start stays the source of truth on `response.url`.
- **Untracked ids are benign.** A message for an id that isn't tracked is a
  late/duplicate event for an already-terminal entry (or an unsolicited
  `Cancelled` ack). The `withTracked` helper logs a WARN and no-ops rather
  than treating it as an error.

## Step machine: a rigorous FSM

The step machine is a textbook finite state machine, decomposed one file
per part under [step-machine/](../src/handler/step-machine/):

| Part                 | File                      | What it holds                                                                          |
| -------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| Input messages       | `messages.ts`             | `PageLoaded`, `Clear`, `CancelAllInFlight`, `SettleTimerFired`, `UrlMatchTimeoutFired` |
| States               | `state.ts`                | `AwaitingPageLoaded`, `TimerPending`, `AwaitingUrlMatch`, `Done`                       |
| Side-effect messages | `messages.ts`             | `Dispatch*`, `Schedule*`, `CancelTimer`, `Warn*`                                       |
| Side-effect handlers | `side-effect-handlers.ts` | one `(msg, ctx) => Effect` per side-effect tag                                         |
| Transition           | `transition.ts`           | pure `(state, input) → [state, effects]`                                               |
| Runtime              | `make.ts`                 | serialized dispatch + timer registry                                                   |

The **transition function is pure** — it never sends a message, forks a
fiber, or logs; it only names the side-effect messages the runtime should
discharge. `make.ts` runs each input through `SynchronizedRef.updateEffect`
(serializing all transitions), commits the next state, and interprets the
named effects in order, all inside that one critical section.

### Timers are inputs, correlated by generation

A pure transition can't fork or interrupt a fiber, so timers are modelled
as messages: a `Schedule*` effect forks a daemon that sleeps and then
re-injects a `SettleTimerFired` / `UrlMatchTimeoutFired` **input** back
through `dispatch`. To tell a live timer from a stale one, every
timer-bearing state carries a monotonic **generation**, and the fired input
carries the generation it was scheduled under. The transition advances only
when the current state is still the matching timer variant _and_ still at
that generation; any intervening re-arm / `clear` / `cancelAllInFlight`
bumps or abandons the generation, so the superseded daemon's fire is
dropped. This is the schema-free replacement for a fiber-identity check.
A `CancelTimer` effect additionally interrupts the registered fiber (a
`Ref<HashMap<generation, Fiber>>`) to save the wasted sleep, but the
generation guard alone is what makes the machine correct.

### Why `dispatch` is not `uninterruptible`

The `SynchronizedRef` lock already makes a transition and its `sendMessage`
atomic, and a timer daemon removes itself from the registry _before_
re-dispatching, so no `CancelTimer` can interrupt an in-flight commit.
Wrapping the dispatch body in `Effect.uninterruptible` is therefore both
unnecessary and actively harmful: `clear` / `cancelAllInFlight` call
`Fiber.interrupt` on a timer fiber _while holding the lock_, and an
uninterruptible region there deadlocks. Its absence is deliberate.

## See also

- [Effect Patterns Reference](../../../../docs/Effect/Patterns%20Reference.md) — repository/handler idioms used here
- [Bridge Explanation](../../../../docs/Messaging/Bridge%20Explanation.md) — the transport these handlers acknowledge messages on
- [telemetry/index.ts](../src/telemetry/index.ts) — the span/attribute catalog the handlers annotate
