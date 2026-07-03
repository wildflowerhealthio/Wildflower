import Cruds from './cruds-permission.ts'
import {
  BasePermission as Base,
  type Interaction,
  type Subtraction,
  type InteractionId,
} from './permission-style.ts'
import ReadWrite from './read-write-permission-style.ts'

type Any = Cruds | ReadWrite

export { type Any, Cruds, ReadWrite, Base, type Interaction, type Subtraction, type InteractionId }
