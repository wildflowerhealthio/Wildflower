import { createContext, useContext, type ReactNode } from 'react'

/**
 * A caller-supplied override for how an error **body** renders. Given the
 * thrown/rejected value, it returns a node to render in place of the default
 * message, or `null` to fall through to the default rendering. This lets an app
 * inject bespoke rendering for particular error shapes (an authorization-failure
 * surface, a rate-limit notice, …) without this generic package having to learn
 * about them.
 */
type ErrorBodyRenderer = (error: unknown) => ReactNode | null

/**
 * The ambient {@link ErrorBodyRenderer}. Defaults to `null` — no override, so
 * error bodies render their default message. Provide it above your router so
 * every {@link PageBodyError} / {@link AsyncErrorView} consults it, rather than
 * threading a prop through each route's `errorComponent`.
 */
const ErrorBodyRendererContext = createContext<ErrorBodyRenderer | null>(null)

/** Read the ambient {@link ErrorBodyRenderer}, or `null` when none is provided. */
const useErrorBodyRenderer = (): ErrorBodyRenderer | null => useContext(ErrorBodyRendererContext)

export { ErrorBodyRendererContext, useErrorBodyRenderer, type ErrorBodyRenderer }
