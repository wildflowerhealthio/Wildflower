import { Data } from 'effect'
import type { Arbitrary, FastCheck } from 'effect'

/**
 * A catch-all error for unanticipated failures where no specific handling exists.
 *
 * All other domain error classes implement `.asUnhandledError()` to convert
 * into this type, making it the terminal error in the error taxonomy.
 * When constructed with a `cause` that is an `Error`, the stack trace and
 * name are inherited from the cause for better debuggability.
 */
class UnhandledError extends Data.TaggedError('UnhandledError')<{
  cause?: unknown
  message: string
}> {
  constructor(params: { cause?: unknown; message: string }) {
    super(params)
    if (this.cause instanceof Error) {
      this.message = params.message ?? this.cause.message ?? this.message
      this.stack = this.cause.stack ?? this.stack
      if (this.cause.name) {
        this.name = `Unhandled${this.cause.name}`
      }
    } else {
      this.message = params.message ?? this.message
    }
  }

  /** Converts any domain error to `UnhandledError`. For `UnhandledError` itself, returns `this`. */
  asUnhandledError(): UnhandledError {
    return this
  }

  /**
   * Coerce an unknown value into an `UnhandledError`.
   *
   * 1. If the value is already an `UnhandledError`, return it as-is.
   * 2. If the value has an `asUnhandledError` method, call it and return the
   *    result — provided the result is actually an `UnhandledError` instance.
   * 3. Otherwise, wrap the value in a new `UnhandledError`.
   */
  static fromUnknown(err: unknown): UnhandledError {
    if (err instanceof UnhandledError) {
      return err
    }
    if (
      err instanceof ExternalAssertionError ||
      err instanceof DataIntegrityError ||
      err instanceof NotFoundError ||
      err instanceof AuthError ||
      err instanceof AuthzError
    ) {
      const converted = err.asUnhandledError()
      if (converted instanceof UnhandledError) {
        return converted
      }
    }
    return new UnhandledError({ cause: err, message: String(err) })
  }

  static get arbitrary(): Arbitrary.LazyArbitrary<UnhandledError> {
    return (fc: typeof FastCheck) =>
      fc
        .string()
        .chain((message) => fc.anything().map((cause) => new UnhandledError({ cause, message })))
  }
}

/**
 * Raised when an external system (API, third-party service) violates an
 * expected contract. The `expected` field describes what was anticipated,
 * making it clear this is an integration-boundary failure rather than a
 * bug in application logic.
 */
class ExternalAssertionError extends Data.TaggedError('ExternalAssertionError')<{
  /** Description of what the system expected from the external source. */
  expected: string
  cause?: unknown
}> {
  constructor(params: { cause: unknown; expected: string }) {
    super(params)
    if (this.cause instanceof Error) {
      this.message = this.cause.message ?? this.message
      this.stack = this.cause.stack ?? this.stack
      if (this.cause.name) {
        this.name = `Unhandled${this.cause.name}`
      }
    }
  }

  /** Converts to {@link UnhandledError} with a message describing the failed expectation. */
  asUnhandledError(): UnhandledError {
    return new UnhandledError({
      cause: this.cause,
      message: `External assertion failed: expected ${this.expected}`,
    })
  }
}

/**
 * Raised when data controlled within the system does not conform to an
 * expected schema. This signals a data-integrity issue (e.g. corrupt
 * records, migration gaps) rather than invalid user input.
 */
class DataIntegrityError extends Data.TaggedError('DataIntegrityError')<{
  message: string
  cause?: unknown
}> {
  constructor(params: { cause?: unknown; message: string }) {
    super(params)
    if (this.cause instanceof Error) {
      this.message = params.message ?? this.cause.message ?? this.message
      this.stack = this.cause.stack ?? this.stack
      if (this.cause.name) {
        this.name = `Unhandled${this.cause.name}`
      }
    } else {
      this.message = params.message ?? this.message
    }
  }

  /** Converts to {@link UnhandledError} with a message describing the data-integrity issue. */
  asUnhandledError(): UnhandledError {
    return new UnhandledError({
      cause: this.cause,
      message: `Data integrity issue: ${this.message}`,
    })
  }
}

/**
 * Raised when a requested resource cannot be located.
 *
 * @typeParam ResourceType - A string literal identifying the kind of resource (e.g. `"Patient"`, `"Questionnaire"`)
 * @typeParam Parameters - The lookup parameters that failed to match (e.g. `{ id: string }`)
 */
class NotFoundError<
  out ResourceType extends string,
  out Parameters extends Record<string, unknown>,
> extends Data.TaggedError('NotFoundError')<{
  /** The kind of resource that was not found (e.g. `"Patient"`, `"Questionnaire"`). */
  resourceType: ResourceType
  /** The lookup parameters that failed to match (e.g. `{ id: "abc123" }`). */
  params: Parameters
  cause?: unknown
}> {
  static readonly tag = 'NotFoundError'

  /** Converts to {@link UnhandledError} with a message including `resourceType` and `params`. */
  asUnhandledError(): UnhandledError {
    return new UnhandledError({
      cause: this.cause,
      message: `Resource of type ${String(this.resourceType)} not found with parameters: ${JSON.stringify(
        this.params
      )}`,
    })
  }
}

/**
 * Raised when a user's identity cannot be verified. Includes a static
 * `Unauthenticated` singleton for the common "not logged in" case.
 */
class AuthError extends Data.TaggedError('AuthError')<{
  message: string
  cause?: unknown
}> {
  static readonly tag = 'AuthError' as const

  /** Convenience singleton for the common "not logged in" case. */
  static Unauthenticated = new AuthError({
    message: 'User is not authenticated',
  })

  /** Converts to {@link UnhandledError} with a message describing the auth failure. */
  asUnhandledError(): UnhandledError {
    return new UnhandledError({
      cause: this.cause,
      message: `Authentication error: ${this.message}`,
    })
  }

  static get arbitrary(): Arbitrary.LazyArbitrary<AuthError> {
    return (fc: typeof FastCheck) => fc.string().map((message) => new AuthError({ message }))
  }
}

/**
 * Raised when an authenticated user lacks the permissions required for
 * the requested operation. Distinct from {@link AuthError} which covers
 * identity verification failures.
 */
class AuthzError extends Data.TaggedError('AuthzError')<{
  message: string
  cause?: unknown
}> {
  static readonly tag = 'AuthzError' as const

  /** Converts to {@link UnhandledError} with a message describing the authorization failure. */
  asUnhandledError(): UnhandledError {
    return new UnhandledError({
      cause: this.cause,
      message: `Authorization error: ${this.message}`,
    })
  }

  static get arbitrary(): Arbitrary.LazyArbitrary<AuthzError> {
    return (fc: typeof FastCheck) =>
      fc
        .string()
        .chain((message) => fc.anything().map((cause) => new AuthzError({ cause, message })))
  }
}

/**
 * A sentinel error representing an in-progress loading state for a given
 * entity.
 *
 * @typeParam Entity - The type of resource being loaded; must implement `toString()` for the error message
 *
 * @remarks
 * Use this when "still loading" must travel through an Effect error
 * channel — for example, when a `SubscriptionRef` or `Subscribable` starts
 * in an unresolved state and downstream consumers need to distinguish
 * "not yet available" from "successfully loaded". For UI-layer loading
 * state that doesn't need to propagate through Effect
 */
class Loading<Entity extends { toString(): string }> extends Data.TaggedError('Loading')<{
  entity: Entity
}> {
  static readonly tag = 'Loading' as const
  constructor(params: { entity: Entity }) {
    super(params)
    this.message = `Loading ${params.entity.toString()}...`
  }
}

export {
  UnhandledError,
  ExternalAssertionError,
  NotFoundError,
  DataIntegrityError,
  AuthError,
  AuthzError,
  Loading,
}
