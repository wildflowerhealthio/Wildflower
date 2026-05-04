import { Schema } from 'effect'

import { mutableEncoded, OrNullAsOptional } from 'kitchen-sink/schema'

// oxlint-disable-next-line @typescript-eslint/explicit-function-return-type -- return type depends on generic schema parameter
export const domainIdentification = <TDomainType extends string>(domainType: TDomainType) =>
  mutableEncoded(
    Schema.Struct({
      resourceType: Schema.Literal(domainType),
      id: OrNullAsOptional(Schema.String),
    })
  )
