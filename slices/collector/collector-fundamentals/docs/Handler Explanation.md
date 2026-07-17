# Handler Explanation

How `src/handler/` turns the raw sniffer-event stream flowing back from the
Tauri host into parsed resources and scripted navigation. Read the
[Bridge Explanation](../../../../docs/Messaging/Bridge%20Explanation.md)
first for the webview↔host channel these handlers sit on, and
[scraping-plan.ts](../src/model/scraping-plan.ts) for the per-slice
configuration they consume. For how these handlers sit inside the whole
"Import Now" pipeline (config → registry dispatch → drive loop → persist),
see the [Collector Sync Explanation](./Collector%20Sync%20Explanation.md).

## Two machines and a lifecycle, one surface

`CollectorBridgeMessageHandler.make` ([collector-bridge-message-handler.ts](../src/handler/collector-bridge-message-handler.ts))
composes **two independent machines plus a lifecycle** into the single handler
record the bridge dispatches inbound messages to:

- The **response tracker** ([sniffer-response-tracker.ts](../src/handler/sniffer-response-tracker.ts))
  owns the five response events (`ResponseStart` / `ResponseData` /
  `ResponseFinished` / `RequestError` / `Cancelled`) and the
  `incompleteSniffedRequests` map (each entry is a sniffed request still
  accumulating body chunks).
- The **automatic-navigation machine** ([automatic-navigation/](../src/handler/automatic-navigation/)) owns
  `PageLoaded` and drives the scripted `stepSequence` through settle-timer
  and URL-match-timeout daemons.
- The **run lifecycle** ([run-lifecycle-state.ts](../src/handler/run-lifecycle-state.ts))
  owns the `requestSniffingResults` stream and every way a run can end —
  `handleSniffingComplete`, `abandonAllRequestSniffing`, `cancelAllRequestSniffing`
  — see [Termination](#termination-the-run-lifecycle).

The two machines share **no state**. Their only channel to each other is the
supplied `sendMessage` — both ask the host to send outbound messages, but
neither reads the other's internals. The composition threads the shared inputs
into both (the automatic-navigation machine gets `scrapingPlan`; the tracker gets a `matchEntity`
derived from `scrapingPlan.entityDefinitions`) and wires them to the lifecycle:
the tracker publishes into the lifecycle's stream (via `handleNewSniffResult`,
which offers the result and then runs the close-check), and the automatic-navigation machine's terminal
`SniffingComplete` reaches the lifecycle through an explicit
**`onSniffingComplete` hook** — not by sniffing the outbound message tag. The
automatic-navigation machine treats that hook as an opaque effect, so the machines still share no
state; the lifecycle is the sole mediator.

The three parts form a **construction cycle** — the tracker publishes into the
lifecycle's stream, the lifecycle reads the tracker's incomplete-request state
and the automatic-navigation machine's completion, and its teardown drives both machines. It is
broken the way the automatic-navigation machine breaks its own `dispatch`/`ctx` cycle
([make.ts](../src/handler/automatic-navigation/make.ts)): forward references that are
only _invoked_ after construction (the tracker's `handleNewSniffResult` fires only
when a request settles; the lifecycle's teardown fires only at teardown), so there is no
temporal-dead-zone hazard.

Keeping the two machines separate is a deliberate shape choice: the response
tracker is a keyed collection of independent per-id accumulators, not an
automaton, so it is _not_ modelled as a state machine even though the
automatic-navigation machine is. Forcing a transition table onto it would add
ceremony (a state per id) for no benefit.

## Response tracker: the drop-then-offer invariant

Every terminal path — `ResponseFinished` (parsed), `RequestError`,
`Cancelled`, and a base64 decode failure inside `ResponseData` — does the
same two things in the same order: **drop** the tracked id, then **publish** the
settled `SniffResult` via the injected `handleNewSniffResult`. This is the
`offerSniffResultAndUntrack` helper, and the order is load-bearing.

`handleNewSniffResult` (the lifecycle seam the tracker is handed) does two things
of its own, also in order: it offers the result onto `requestSniffingResults`
(synchronously, `unsafeOffer`), _then_ runs the close-check
`endRequestSniffingResultsUnlessMoreExpected`. Because that close-check now fires
from inside the publish, **the drop must already have happened when publish
runs.** The lifecycle closes the stream the moment the last incomplete request is
gone from the map _after_ sniffing is complete (see below); if the id were still
in the map at check time — as it would be if the path published before dropping —
the check would see "still incomplete" and the final settle would never close the
stream, hanging the run.

Dropping first is safe precisely because the offer happens _before_ the check
inside `handleNewSniffResult`: the result is queued ahead of the close (`end` on a
non-empty mailbox leaves it draining, so the consumer still takes it). The drop,
the offer, and the check all run synchronously with no intervening handler, so no
other event can observe the momentary "dropped but not yet offered" state. The
parse in `ResponseFinished` is span-wrapped and latency-bearing, but it runs
_before_ `offerSniffResultAndUntrack` — by the time the drop-then-offer sequence
starts there is no further yield point.

The idle-timeout abandon path is the exception: `failIncompleteSniffedRequests`
publishes each stalled request with `abandoned` set and force-closes the
stream itself, so `handleNewSniffResult` skips the per-result close-check there
(running it would be pointless — the map isn't cleared until every failure is
published).

The lifecycle exposes the stream read-only (as `requestSniffingResults`), so the
consumer reads the same queue the tracker publishes into — there is no `onResult`
callback and no adapter in between.

## Termination: the run lifecycle

### The theory: two gates, three phases, two exits

A run is a bounded producer of `SniffResult`s on `requestSniffingResults`. Its
whole state is two independent facts:

- **Gate A — sniffing** (the scripted navigation): `running → complete`.
  Monotonic. While running it can start new sniffed requests; once complete
  (`SniffingComplete`), no new request can begin.
- **Gate B — incomplete sniffed requests** (the tracker's map): fluctuates as
  requests start and settle.

The stream stays open while more results are possible and closes when none are —
exactly `A complete ∧ B empty`. So the run occupies one of three phases: **active**
(sniffing running and/or requests incomplete), **quiescing** (sniffing complete,
requests still incomplete — draining the last few), **quiesced** (both gates met;
stream closed = natural completion).

### The lifecycle owns every end-path

Termination lives in the run lifecycle rather than spread across the tracker, a
composition wrapper, and the automatic-navigation machine. The lifecycle owns
`requestSniffingResults` and the `sniffingComplete` latch (Gate A); it reads
_whether any request is still incomplete_ (Gate B) through the injected
`hasIncompleteSniffedRequests` — the tracker's map stays the single source of
truth, so there is no shadow counter to drift.

| End-path                    | publishes                     | closes the stream?            | trigger                                           |
| --------------------------- | ----------------------------- | ----------------------------- | ------------------------------------------------- |
| natural completion          | (results, via prior settles)  | once no request is incomplete | automatic-navigation machine's `SniffingComplete` |
| `abandonAllRequestSniffing` | incomplete requests as `Left` | now                           | consumer's idle timeout                           |
| `cancelAllRequestSniffing`  | nothing                       | no (consumer has gone)        | screen unmount                                    |

Completion is thus a property of the stream, not a predicate the consumer
computes. After each settle (and when Gate A is first set),
`endRequestSniffingResultsUnlessMoreExpected` runs — two guards: if sniffing is
not yet complete, or any request is still incomplete, more results are expected,
so return; otherwise close the stream. The consumer's drive loop simply drains
until `take` reports it done.

- **`handleSniffingComplete`** flips the `sniffingComplete` latch (Gate A) then runs
  the close-check. The automatic-navigation machine's terminal `DispatchSniffingComplete`
  side-effect sends `SniffingComplete` to the host _then_ runs the
  `onSniffingComplete` hook the composition wired to `lifecycle.handleSniffingComplete`
  — both inside the one span. (The machines still share no state — the lifecycle
  mediates.)
- **`abandonAllRequestSniffing`** is the idle-timeout escape. The consumer calls it
  when its drive loop has been idle past its timeout (a stalled download whose
  `ResponseData` chunks never produced a terminal): the tracker's
  `failIncompleteSniffedRequests` publishes every still-incomplete request as a
  `Left` failure, then the lifecycle closes the stream _now_ — it force-closes
  (bypassing Gate A) because at an idle timeout sniffing may not yet be complete.
- **`cancelAllRequestSniffing`** is the screen-unmount teardown. It runs
  `stopAutomaticNavigation` (interrupt the automatic-navigation machine's timer) then the tracker's
  `cancelIncompleteSniffedRequests` (send a `CancelSnifferRequest` to the host per
  incomplete id, then drop them). It publishes nothing and does **not** close the
  stream — the consumer has gone. Navigation-first is **not** load-bearing (the
  machines share no state) but is preserved so the externally visible order of
  outbound messages is byte-for-byte unchanged.

Two supporting invariants:

- **Entity pinned at `ResponseStart`.** The matching `EntityDefinition` is
  resolved once (via the injected `matchEntity`), when the stream starts, and
  stored on the tracked entry. Later events never re-run `matchEntity`, so a
  redirected `RequestError.url` (or any mid-stream change) can't reroute parsing.
  The `url` captured at start stays the source of truth on `response.url`.
- **Untracked ids are benign.** A message for an id that isn't tracked is a
  late/duplicate event for an already-terminal entry (or an unsolicited
  `Cancelled` ack). The `withTracked` helper logs a WARN and no-ops rather
  than treating it as an error.

## Automatic navigation: a rigorous FSM

The automatic-navigation machine is a textbook finite state machine, decomposed one file
per part under [automatic-navigation/](../src/handler/automatic-navigation/):

| Part                 | File                      | What it holds                                                    |
| -------------------- | ------------------------- | ---------------------------------------------------------------- |
| Input messages       | `messages.ts`             | `PageLoaded`, `Stop`, `SettleTimerFired`, `UrlMatchTimeoutFired` |
| States               | `state.ts`                | `AwaitingPageLoaded`, `TimerPending`, `AwaitingUrlMatch`, `Done` |
| Side-effect messages | `messages.ts`             | `Dispatch*`, `Schedule*`, `CancelTimer`, `Warn*`                 |
| Side-effect handlers | `side-effect-handlers.ts` | one `(msg, ctx) => Effect` per side-effect tag                   |
| Transition           | `transition.ts`           | pure `(state, input) → [state, effects]`                         |
| Runtime              | `make.ts`                 | serialized dispatch + timer registry                             |

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
that generation; any intervening re-arm / `stopAutomaticNavigation`
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
unnecessary and actively harmful: `stopAutomaticNavigation` calls
`Fiber.interrupt` on a timer fiber _while holding the lock_, and an
uninterruptible region there deadlocks. Its absence is deliberate.

## See also

- [Effect Patterns Reference](../../../../docs/Effect/Patterns%20Reference.md) — repository/handler idioms used here
- [Bridge Explanation](../../../../docs/Messaging/Bridge%20Explanation.md) — the transport these handlers acknowledge messages on
- [telemetry/index.ts](../src/telemetry/index.ts) — the span/attribute catalog the handlers annotate
