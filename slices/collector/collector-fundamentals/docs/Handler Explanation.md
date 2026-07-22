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
  `PageLoaded` and a **breadth-first step queue** — seeded from `stepSequence`
  and grown by entities' `followUpSteps` — driven through delay-timer and
  URL-match-timeout daemons. There is no implicit inter-step settle; plans
  insert explicit `Delay` steps where a wait matters.
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
which offers the result and then runs the close-check) and injects an entity's
generated `followUpSteps` into the machine (via `handleGeneratedSteps`, which
the composition wraps with dedup + cap). The automatic-navigation machine's
terminal `SniffingComplete` reaches the lifecycle through an explicit
**`onSniffingComplete` hook**, and the machine's queue-drained fact through an
**`onDrained` hook** — not by sniffing the outbound message tag. Conversely the
lifecycle drives the machine's completion by injecting `NoMoreResultsExpected`
(`signalNoMoreResultsExpected`) when the incomplete-request map empties. The
automatic-navigation machine treats those hooks as opaque effects, so the
machines still share no state; the lifecycle is the sole mediator.

The three parts form a **construction cycle** — the tracker publishes into the
lifecycle's stream and injects generated steps into the machine, the lifecycle
reads the tracker's incomplete-request state and drives the machine's
completion, and its teardown drives both machines. It is broken the way the
automatic-navigation machine breaks its own `dispatch`/`ctx` cycle
([make.ts](../src/handler/automatic-navigation/make.ts)): forward references that are
only _invoked_ after construction (the tracker's hooks fire only
when a request settles; the lifecycle's `signalNoMoreResultsExpected` and teardown
fire only later), so there is no temporal-dead-zone hazard.

Keeping the two machines separate is a deliberate shape choice: the response
tracker is a keyed collection of independent per-id accumulators, not an
automaton, so it is _not_ modelled as a state machine even though the
automatic-navigation machine is. Forcing a transition table onto it would add
ceremony (a state per id) for no benefit.

## Response tracker: the generate-then-drop-then-offer invariant

Every terminal path — `ResponseFinished` (parsed), `RequestError`,
`Cancelled`, and a base64 decode failure inside `ResponseData` — does the
same two things in the same order: **drop** the tracked id, then **publish** the
settled `SniffResult` via the injected `handleNewSniffResult`. This is the
`offerSniffResultAndUntrack` helper, and the order is load-bearing.

A successful `ResponseFinished` parse prepends a third step: **generate**. Before
the drop, it calls the pinned entity's `followUpSteps` (if any) with the parsed
resources and the settled `RemoteResponse`, and hands them to
`handleGeneratedSteps` — so the full order is **generate → drop → offer**. The
generate-first ordering is what makes completion race-free: injecting the
generated steps moves the machine _out of_ `Drained` (see [Termination](#termination-the-run-lifecycle))
before the offer's close-check can inject `NoMoreResultsExpected`, so the machine
can never observe "no more results" before it has seen the steps this settle
produced. Failed parses, `RequestError`, `Cancelled`, and the abandon path
generate nothing.

`followUpSteps` runs on freshly-parsed, possibly-malformed data, so the generate
step is wrapped defensively (like `parse`'s `Effect.either`): if the generator
throws, the tracker WARN-logs and generates nothing, then **still** drops and
offers. A throw must not skip the drop-then-offer — that would strand the id in
the incomplete map (Gate B never empties) and hang the run until the idle
timeout.

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
whole state is two facts:

- **Gate A — sniffing** (the scripted navigation): `running → complete`.
  Monotonic. Once complete (the machine dispatched `SniffingComplete`), no new
  request can begin.
- **Gate B — incomplete sniffed requests** (the tracker's map): fluctuates as
  requests start and settle.

The stream stays open while more results are possible and closes when none are —
exactly `A complete ∧ B empty`.

**With breadth-first `followUpSteps` generation, Gate A now _depends on_ Gate B.**
The machine can't declare completion just because its queue is empty — any
in-flight request could still parse into follow-ups — so natural completion is
_queue drained (`Drained`) ∧ no incomplete request_. Gate A is reached only via
the lifecycle: whenever the incomplete map empties, the lifecycle injects
`NoMoreResultsExpected` into the machine (`signalNoMoreResultsExpected`), which
completes it (`Drained → Done`, dispatching `SniffingComplete`) iff its queue is
already drained. The coupling is symmetric — completion must be re-checked
whenever _either_ fact becomes true — so the machine also re-checks on the other
edge: when its queue drains (`Drained`) it fires the `onDrained` hook, wired to
the same lifecycle close-check, which injects `NoMoreResultsExpected` if the map
is already empty (this is how a trailing `Delay` completes — the map often empties
_before_ the queue drains). The machines still share no state; both facts flow as
explicit inputs/hooks through the lifecycle.

The run occupies one of three phases: **active** (sniffing running and/or requests
incomplete), **quiescing** (queue drained, requests still incomplete — draining
the last few), **quiesced** (both gates met; stream closed = natural completion).

> **No implicit settle window.** Completion closes the stream as soon as the two
> gates hold — there is no grace period. The page's `fetch`/`XHR` shims stay live
> after `SniffingComplete`, so a plan that needs post-load XHR fan-out to finish
> before completing inserts an explicit **trailing `Delay` step**: it delays
> reaching `Drained`, keeping the run open while those requests start and are
> tracked.

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
computes. `endRequestSniffingResultsUnlessMoreExpected` runs after each settle
_and_ whenever the machine's queue drains (its `onDrained` hook is wired to it):
if any request is still incomplete, more results are expected, so return;
otherwise inject `NoMoreResultsExpected` into the machine (completing it iff its
queue is drained) and — if sniffing is now complete — close the stream. The
consumer's drive loop simply drains until `take` reports it done.

- **`handleSniffingComplete`** flips the `sniffingComplete` latch (Gate A) then
  closes the stream if no request is still incomplete. The automatic-navigation
  machine's terminal `DispatchSniffingComplete` side-effect sends `SniffingComplete`
  to the host _then_ runs the `onSniffingComplete` hook the composition wired to
  `lifecycle.handleSniffingComplete` — both inside the one span. It deliberately
  does **not** re-inject `NoMoreResultsExpected` (that would re-enter the machine's
  lock while the terminal transition still holds it — a deadlock); it only closes.
  A url-match-timeout abort reaches `Done` with requests possibly still in flight,
  so `handleSniffingComplete` withholds the close then and lets the last settle's
  close-check do it. (The machines still share no state — the lifecycle mediates.)
- **`abandonAllRequestSniffing`** is the idle-timeout escape. The consumer calls it
  when its drive loop has been idle past its timeout (a stalled download whose
  `ResponseData` chunks never produced a terminal): it `stopAutomaticNavigation`s
  the machine first (so a parked `Delay`/URL-match timer can't leak), then the
  tracker's `failIncompleteSniffedRequests` publishes every still-incomplete
  request as a `Left` failure, then the lifecycle closes the stream _now_ — it
  force-closes (bypassing Gate A) because at an idle timeout sniffing may not yet
  be complete.
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

The automatic-navigation machine is a textbook finite state machine whose
identity is **owner of a step queue** (seeded from `stepSequence`, grown by
`followUpSteps`), decomposed one file per part under
[automatic-navigation/](../src/handler/automatic-navigation/):

| Part                 | File                    | What it holds                                  |
| -------------------- | ----------------------- | ---------------------------------------------- |
| Input messages       | messages.ts             | the six inputs that drive the machine          |
| States               | state.ts                | five states; active variants carry the queue   |
| Side-effect messages | messages.ts             | the effects a transition can request           |
| Side-effect handlers | side-effect-handlers.ts | one `(msg, ctx) => Effect` per side-effect tag |
| Transition           | transition.ts           | pure `(state, input) → [state, effects]`       |
| Runtime              | make.ts                 | serialized dispatch + timer registry           |

The inputs are `PageLoaded`, `Stop`, `DelayTimerFired`, `UrlMatchTimeoutFired`,
`StepsGenerated`, and `NoMoreResultsExpected`; the states are
`AwaitingPageLoaded`, `DelayPending`, `AwaitingUrlMatch`, `Drained`, and `Done`.
Because the queue lives in the state, the transition needs no `ScrapingPlan`
closure — it names `SetStepName` / `DispatchNavigation` / `DispatchSniffingComplete` /
`Schedule*` / `CancelTimer` / `RequestCompletionCheck` / `Warn*` effects for the
runtime to discharge.

On the first `PageLoaded` the machine begins draining the queue front-to-back,
and it keeps draining as far as it can each turn: a `Navigation` **dispatches its
`action` and immediately advances** (a `Fill` / `Click` / `Open` never waits for
a `PageLoaded`, so consecutive navigations dispatch back-to-back), a `Delay` arms
a timer for its `duration` and rests, an `AwaitPageSettled` parks until a settled
`PageLoaded` matches its `pattern` (or aborts on its `timeout`) — resuming the
drain from the tail on a match — and an empty queue transitions to `Drained`. A
`StepsGenerated` input appends to the back of the queue (breadth-first), or from
`Drained` re-awakens the machine and drains the new steps with no `PageLoaded`.

As it reaches each step — before that step's own dispatch, timer, or park — the
machine emits a leading `SetStepName` for the step's required `name`, which the
handler forwards as a `SetSnifferStatus` bridge message; the Tauri host writes it
to the sniffer chrome's subtitle so the running step is visible. A back-to-back
`Navigation` run therefore flushes several names in one turn and only the last is
seen — names on hold steps (or a `Navigation` gated by a following hold) are the
ones a user reliably reads.
There is **no implicit settle timer**: all waiting is an explicit `Delay` or
`AwaitPageSettled` step, so `AwaitingPageLoaded` is a start-up-only resting state
(nothing but `Stop` returns to it).

The **transition function is pure** — it never sends a message, forks a
fiber, or logs; it only names the side-effect messages the runtime should
discharge. `make.ts` runs each input through `SynchronizedRef.updateEffect`
(serializing all transitions), commits the next state, and interprets the
named effects in order, all inside that one critical section.

The `RequestCompletionCheck` side-effect (emitted on entering `Drained`) is the
one that must _not_ run inline: it forks the injected `onDrained` effect, exactly
like a timer daemon, so the lifecycle's `NoMoreResultsExpected` injection
re-enters the machine's lock _after_ the current transition commits — never
re-entrant. See [Termination](#termination-the-run-lifecycle) for the completion
coupling this drives.

### Timers are inputs, correlated by generation

A pure transition can't fork or interrupt a fiber, so timers are modelled
as messages: a `Schedule*` effect forks a daemon that sleeps and then
re-injects a `DelayTimerFired` / `UrlMatchTimeoutFired` **input** back
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
