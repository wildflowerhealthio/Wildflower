declare module 'dicom-parser' {
  interface Element {
    readonly tag: string
    readonly vr: string | undefined
    readonly dataOffset: number
    readonly length: number
    readonly items?: readonly DataSet[] | undefined
  }

  interface DataSet {
    readonly byteArray: Uint8Array
    readonly elements: Readonly<Record<string, Element>>
    readonly warnings: readonly string[]
    string(tag: string): string | undefined
    uint16(tag: string): number | undefined
    intString(tag: string): number | undefined
    float(tag: string): number | undefined
  }

  interface ParseOptions {
    readonly untilTag?: string | undefined
    readonly vrCallback?: ((tag: string) => string) | undefined
  }

  function parseDicom(byteArray: Uint8Array, options?: ParseOptions): DataSet
}
