import { Either, Schema } from 'effect'
import type { ParseError } from 'effect/ParseResult'
import { RemoteEntity } from './entity.ts'
import type * as Link from './link.ts'

const SimpleEntitySchema = Schema.Struct({
  name: Schema.String,
  age: Schema.Number,
})

class SimpleEntity extends RemoteEntity<{ name: string; age: number }> {
  public static readonly name = 'SimpleEntity'
  public static isFoundAt(url: string): boolean {
    return /\/people\/\d+$/.test(url)
  }
  private readonly decode = Schema.decodeEither(Schema.parseJson(SimpleEntitySchema))

  public override parse(): Either.Either<
    { resources: { name: string; age: number }[]; links: Link.Any[] },
    ParseError
  > {
    return this.decode(this.body).pipe(
      Either.map((data) => ({
        resources: [data],
        links: [{ _tag: 'Open' as const, href: `/people/${data.name}` }],
      }))
    )
  }
}

class AnotherEntity extends RemoteEntity<{ id: string }> {
  public static readonly name = 'AnotherEntity'
  public static isFoundAt(url: string): boolean {
    return /\/items\//.test(url)
  }
  private readonly decode = Schema.decodeEither(
    Schema.parseJson(Schema.Struct({ id: Schema.String }))
  )

  public override parse(): Either.Either<
    { resources: readonly { id: string }[]; links: readonly Link.Any[] },
    ParseError
  > {
    return this.decode(this.body).pipe(
      Either.map((data) => ({
        resources: [data],
        links: [],
      }))
    )
  }
}

export { SimpleEntity, AnotherEntity }
