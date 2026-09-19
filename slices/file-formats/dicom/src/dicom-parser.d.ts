declare module 'dicom-parser' {
  /** One fragment of an encapsulated Pixel Data element. */
  interface Fragment {
    readonly offset: number
    readonly position: number
    readonly length: number
  }

  interface Element {
    readonly tag: string
    readonly vr: string | undefined
    readonly dataOffset: number
    readonly length: number
    readonly items?: readonly DataSet[] | undefined
    /**
     * Set on Pixel Data (7FE0,0010) written with an undefined length, which is
     * how every compressed transfer syntax carries its frames. `fragments`
     * then holds one entry per encapsulation item.
     */
    readonly encapsulatedPixelData?: boolean | undefined
    readonly fragments?: readonly Fragment[] | undefined
  }

  interface DataSet {
    readonly byteArray: Uint8Array
    readonly elements: Readonly<Record<string, Element>>
    readonly warnings: readonly string[]
    string(tag: string): string | undefined
    uint16(tag: string): number | undefined
    intString(tag: string): number | undefined
    /** Parse a DS (Decimal String) value as a float. */
    floatString(tag: string, index?: number): number | undefined
    float(tag: string): number | undefined
  }

  interface ParseOptions {
    readonly untilTag?: string | undefined
    readonly vrCallback?: ((tag: string) => string) | undefined
  }

  function parseDicom(byteArray: Uint8Array, options?: ParseOptions): DataSet
}
