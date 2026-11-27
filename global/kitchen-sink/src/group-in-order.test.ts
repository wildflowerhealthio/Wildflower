import { Data } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { groupInOrder } from './group-in-order.ts'

describe('groupInOrder', () => {
  it('should put each group where its first item is and keep each group’s items in order', () => {
    // Arrange
    const words = ['pear', 'apple', 'plum', 'avocado', 'cherry', 'peach']

    // Act
    const groups = groupInOrder(words, (word) => word.charAt(0))

    // Assert
    expect(groups).toEqual([
      { key: 'p', items: ['pear', 'plum', 'peach'] },
      { key: 'a', items: ['apple', 'avocado'] },
      { key: 'c', items: ['cherry'] },
    ])
  })

  it('should compare keys by Equal, so two equal structs are one key', () => {
    // Arrange
    const entries = [
      { key: Data.struct({ system: 'a', value: '1' }), name: 'first' },
      { key: Data.struct({ system: 'b', value: '1' }), name: 'second' },
      { key: Data.struct({ system: 'a', value: '1' }), name: 'third' },
    ]

    // Act
    const groups = groupInOrder(entries, ({ key }) => key)

    // Assert
    expect(groups.map(({ items }) => items.map(({ name }) => name))).toEqual([
      ['first', 'third'],
      ['second'],
    ])
  })

  it('should give no group for no item', () => {
    // Arrange / Act
    const groups = groupInOrder([], (item: string) => item)

    // Assert
    expect(groups).toEqual([])
  })
})
