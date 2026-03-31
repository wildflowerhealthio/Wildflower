export const makeOnlyFields =
  <T extends { fields: { readonly [K: string]: unknown }; new (...args: any[]): any }>(
    klass: T,
    instance: InstanceType<T>
  ) =>
  (): Pick<InstanceType<T>, keyof T['fields']> => {
    const o: any = {}
    for (const key of Object.keys(klass.fields)) {
      o[key] = instance[key]
    }
    return o
  }
