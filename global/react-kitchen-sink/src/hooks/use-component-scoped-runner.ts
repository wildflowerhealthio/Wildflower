import { Effect, Fiber, Layer } from 'effect'
import { useEffect } from 'react'

/**
 * Mount-tied `Layer.launch`: forks the layer on mount and interrupts
 * the resulting fiber on cleanup. Both the launch and the cleanup
 * interrupt are routed through `Effect.runFork` because each is itself
 * an Effect — calling `Layer.launch(layer)` or `Fiber.interrupt(fiber)`
 * without `runFork` would be a silent no-op.
 *
 * Pass a `layer` with identity-stable inputs (typically built inside a
 * `useMemo`); the hook's `useEffect` keys on the layer reference, so a
 * fresh layer on every render would relaunch the daemon stack.
 */
const useComponentScopedRunner = (
  arg: Layer.Layer<never, never, never> | Effect.Effect<never, never, never>
): void => {
  useEffect(() => {
    const effect = Effect.isEffect(arg) ? arg : Layer.launch(arg)
    const fiber = Effect.runFork(effect)
    return (): void => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [arg])
}

export { useComponentScopedRunner }
