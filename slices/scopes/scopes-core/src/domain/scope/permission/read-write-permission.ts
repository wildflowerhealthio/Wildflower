/**
 * The **read/write permission** — the SMART-on-FHIR v1 word form (`read`/`write`/`*`),
 * a FHIR-only coarse spelling of a permission. Its *interactions* are the two words
 * `read` and `write`; a {@link BasePermission} is a set of them (`read`, `write`, or
 * both ⇒ `*`). It owns its own serialize/parse and inherits the shared editing algebra
 * (toggle / subset / subtract) from {@link BasePermission}, all read on its own
 * `read`/`write` interactions. A v1 scope is edited entirely in this form — it is never
 * converted into cruds; the v1 grammar mirrors the v1 half of `scopes-rust`'s permission
 * model.
 *
 * Namespace module (`import { ReadWritePermission } from 'scopes-core'`).
 */
import { BasePermission } from './permission.ts'

/** The two SMART v1 Read/Write interactions — FHIR-only. */
class ReadWritePermission extends BasePermission<ReadWritePermission.Interaction> {
  kind = 'readWrite' as const
  layout = 'inline' as const
  items = [
    { id: 'read', name: 'Read', code: 'read' },
    { id: 'write', name: 'Write', code: 'write' },
  ] as const

  static empty = new ReadWritePermission([])
  static read = new ReadWritePermission(['read'])
  static write = new ReadWritePermission(['write'])
  static star = new ReadWritePermission(['read', 'write'])

  make(interactions: Iterable<ReadWritePermission.Interaction>): ReadWritePermission {
    return new ReadWritePermission(interactions)
  }

  serialize(): string | null {
    const canRead = this.interactions.has('read')
    const canWrite = this.interactions.has('write')

    if (canRead && canWrite) return '*'
    if (canRead) return 'read'
    if (canWrite) return 'write'
    return null
  }

  label(): string {
    const canRead = this.interactions.has('read')
    const canWrite = this.interactions.has('write')

    if (canRead && canWrite) return 'read and write'
    if (canRead) return 'read'
    if (canWrite) return 'write'
    return 'none'
  }

  /** Parse a v1 word segment (`read`/`write`/`*`), or `null` if it isn't one. */
  static parse(segment: string): ReadWritePermission | null {
    switch (segment) {
      case 'read':
        return ReadWritePermission.read
      case 'write':
        return ReadWritePermission.write
      case '*':
        return ReadWritePermission.star
      default:
        return null
    }
  }
}

namespace ReadWritePermission {
  /** A single v1 interaction — one of the two editable words. Both ⇒ `*`; neither ⇒ no scope. */
  export type Interaction = 'read' | 'write'
}

export default ReadWritePermission
