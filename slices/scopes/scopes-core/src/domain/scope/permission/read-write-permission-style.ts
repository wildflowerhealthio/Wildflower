/**
 * The **read/write permission style** — the SMART-on-FHIR v1 word form
 * (`read`/`write`/`*`), a FHIR-only coarse spelling of a permission. Its
 * *interactions* are the two words `read` and `write`; a {@link BasePermission} is a
 * set of them (`read`, `write`, or both ⇒ `*`). It owns its own serialize/parse and
 * inherits the shared editing algebra (toggle / subset / subtract) from
 * {@link BasePermission}, all read on its own `read`/`write` interactions. A v1 scope
 * is edited entirely in this style — it is never converted into cruds; the v1
 * grammar mirrors the v1 half of `scopes-rust`'s permission model.
 *
 * Namespace module (`import { ReadWritePermissionStyle } from 'scopes-core'`).
 */
import { BasePermission } from './permission-style.ts'

/** The two SMART v1 Read/Write interactions — FHIR-only. */
class ReadWritePermissionStyle extends BasePermission<ReadWritePermissionStyle.Interaction> {
  kind = 'readWrite' as const
  layout = 'inline' as const
  items = [
    { id: 'read', name: 'Read', code: 'read' },
    { id: 'write', name: 'Write', code: 'write' },
  ] as const

  static empty = new ReadWritePermissionStyle([])
  static read = new ReadWritePermissionStyle(['read'])
  static write = new ReadWritePermissionStyle(['write'])
  static star = new ReadWritePermissionStyle(['read', 'write'])

  make(interactions: Iterable<ReadWritePermissionStyle.Interaction>): ReadWritePermissionStyle {
    return new ReadWritePermissionStyle(interactions)
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
  static parse(segment: string): ReadWritePermissionStyle | null {
    switch (segment) {
      case 'read':
        return ReadWritePermissionStyle.read
      case 'write':
        return ReadWritePermissionStyle.write
      case '*':
        return ReadWritePermissionStyle.star
      default:
        return null
    }
  }
}

namespace ReadWritePermissionStyle {
  /** A single v1 interaction — one of the two editable words. Both ⇒ `*`; neither ⇒ no scope. */
  export type Interaction = 'read' | 'write'
}

export default ReadWritePermissionStyle
