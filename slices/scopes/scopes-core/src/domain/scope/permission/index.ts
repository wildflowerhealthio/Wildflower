import Cruds from './cruds-permission.ts'
import {
  BasePermission as Base,
  type Interaction,
  type Subtraction,
  type InteractionId,
} from './permission.ts'
import ReadWrite from './read-write-permission.ts'

type Any = Cruds | ReadWrite

export { type Any, Cruds, ReadWrite, Base, type Interaction, type Subtraction, type InteractionId }
