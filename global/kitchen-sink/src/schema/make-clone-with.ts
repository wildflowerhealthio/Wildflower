export const makeCloneWith =
  <Instance extends object>(klass: { make: (o: Instance) => Instance }, instance: Instance) =>
  (patch: Partial<Instance>): Instance =>
    klass.make({
      ...instance,
      ...patch,
    })
