abstract class BaseScope {
  abstract readonly kind: string

  abstract serialize(): string | null
}

export { BaseScope }
