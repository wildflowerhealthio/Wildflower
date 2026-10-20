// A fixture for book-web's tests: items `typescript-items.ts` must find.

/** The largest count. */
const LIMIT = 3

class Counter {
  private count = 0

  /** Count one more, up to {@link LIMIT}. */
  bump(): number {
    // Stop at the limit.
    if (this.count >= LIMIT) return this.count
    this.count += 1
    return this.count
  }
}

interface Shape {
  /** The shape's area. */
  readonly area: number
}

namespace Shapes {
  export const square = (side: number): Shape => ({
    area: side * side,
  })
}

function twice(value: number): number {
  return value * 2
}

const Point = { x: 0, y: 0 }
type Point = typeof Point

export type { Shape }
export { Counter, LIMIT, Point, Shapes, twice }
