import Cruds from './cruds-permission.ts'
import {
  BasePermission as Base,
  type Interaction,
  type Subtraction,
  type InteractionId,
} from './permission.ts'
import ReadWrite from './read-write-permission.ts'

type Any = Cruds | ReadWrite

namespace Interaction {
  // oxlint-disable-next-line no-shadow
  export type Any = Cruds.Interaction | ReadWrite.Interaction
}

export { type Any, Cruds, ReadWrite, Base, type Interaction, type Subtraction, type InteractionId }
