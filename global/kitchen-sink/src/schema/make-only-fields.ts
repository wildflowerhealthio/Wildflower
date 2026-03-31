export const makeOnlyFields =
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  <T extends { fields: { readonly [K: string]: unknown }; new (...args: any[]): any }>(
    klass: T,
    instance: InstanceType<T>
  ) =>
    (): Pick<InstanceType<T>, keyof T['fields']> => {
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      const o: any = {}
      for (const key of Object.keys(klass.fields)) {
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment
        o[key] = instance[key]
      }
      return o
    }
