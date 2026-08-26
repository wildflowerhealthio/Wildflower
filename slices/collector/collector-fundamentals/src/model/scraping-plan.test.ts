import { Duration, Effect, Hash } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as ScrapingPlan from './scraping-plan.ts'
import type * as Step from './step.ts'

const openStep = (uri: string): Step.Step => ({
  _tag: 'Navigation',
  name: `open ${uri}`,
  action: { _tag: 'Open', source: { _tag: 'Uri', uri } },
})

const planWith = (stepSequence: readonly Step.Step[]): ScrapingPlan.ScrapingPlan<never> =>
  ScrapingPlan.make<never>({
    name: 'FreezeTestPlan',
    responseKinds: [],
    stepSequence,
  })

describe('ScrapingPlan.make', () => {
  it('freezes the plan and the collections a handler holds onto', () => {
    const plan = planWith([openStep('https://example.com/a')])

    // The handler seeds its step queue from `stepSequence` and pins entities per
    // in-flight request, so a caller mutating either after construction would
    // change a run already under way.
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.stepSequence)).toBe(true)
    expect(Object.isFrozen(plan.responseKinds)).toBe(true)
    expect(Object.isFrozen(plan.stepSequence[0])).toBe(true)
  })

  /**
   * Regression: freezing walked *into* `Duration`s. `Duration.infinity` and
   * `Duration.zero` are module-level singletons Effect hands out by reference, so
   * freezing one while building a plan corrupts it for every other holder in the
   * process — and `Duration`'s `Hash` memoises onto the instance with
   * `Object.defineProperty`, which throws on a frozen object.
   */
  it('does not freeze Duration singletons reachable from the plan', () => {
    planWith([
      { _tag: 'Delay', name: 'pause', duration: Duration.zero },
      { _tag: 'AwaitUserDismiss', name: 'await dismiss', timeout: Duration.infinity },
    ])

    expect(Object.isFrozen(Duration.infinity)).toBe(false)
    expect(Object.isFrozen(Duration.zero)).toBe(false)
    // The failure this really guards: a later, unrelated hash of the shared
    // singleton throwing because some plan froze it.
    expect(() => Hash.hash(Duration.infinity)).not.toThrow()
    expect(Duration.toMillis(Duration.zero)).toBe(0)
  })

  /**
   * Pins the *mechanism* the skip exists for, on a throwaway `Duration` rather
   * than a shared singleton. If Effect ever stops memoising its hash onto the
   * instance this stops throwing, and the skip above becomes merely tidy rather
   * than load-bearing — worth knowing when someone questions why it is there.
   */
  it('demonstrates why: hashing a frozen Duration throws', () => {
    const frozen = Object.freeze(Duration.seconds(1))
    expect(() => Hash.hash(frozen)).toThrow()
  })

  it('carries captureProvenance through the clone', () => {
    // `make` copies an explicit field list; a forgotten copy would silently
    // drop the hook and every trace with it. The reference (not a wrapper)
    // must survive, since plan deep-equality in collector tests compares
    // function fields by identity.
    const captureProvenance: NonNullable<ScrapingPlan.ScrapingPlan<never>['captureProvenance']> = (
      _runId,
      _response,
      produced
    ) => Effect.succeed({ resources: produced, diagnostics: [] })
    const plan = ScrapingPlan.make<never>({
      name: 'HookPlan',
      responseKinds: [],
      stepSequence: [],
      captureProvenance,
    })

    expect(plan.captureProvenance === captureProvenance).toBe(true)
  })

  it('keeps Duration-valued step fields readable after freezing', () => {
    const plan = planWith([
      { _tag: 'AwaitUserDismiss', name: 'await dismiss', timeout: Duration.minutes(10) },
    ])
    const [head] = plan.stepSequence

    // Skipping the Duration must not skip the step *holding* it.
    expect(Object.isFrozen(head)).toBe(true)
    expect(head?._tag === 'AwaitUserDismiss' && Duration.toMillis(head.timeout)).toBe(600_000)
  })
})
