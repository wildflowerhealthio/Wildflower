import { describe, expect, test } from 'vite-plus/test'

import { Scope } from '../../../index.ts'

const ReadWrite = Scope.Permission.ReadWrite

describe('ReadWritePermissionStyle — v1 word model', () => {
  test('serialize the words (read/write/*); empty → null', () => {
    expect(ReadWrite.read.serialize()).toBe('read')
    expect(ReadWrite.write.serialize()).toBe('write')
    expect(ReadWrite.star.serialize()).toBe('*')
    expect(ReadWrite.empty.serialize()).toBeNull()
  })

  test('parse the words; reject cruds letter bags', () => {
    expect(ReadWrite.parse('read')).toEqual(ReadWrite.read)
    expect(ReadWrite.parse('write')).toEqual(ReadWrite.write)
    expect(ReadWrite.parse('*')).toEqual(ReadWrite.star)
    expect(ReadWrite.parse('rs')).toBeNull()
  })

  test('label', () => {
    expect(ReadWrite.star.label()).toBe('read and write')
    expect(ReadWrite.read.label()).toBe('read')
    expect(ReadWrite.empty.label()).toBe('none')
  })
})
