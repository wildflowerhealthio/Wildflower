import { Schema } from 'effect'

const InstanceConfig = Schema.Struct({
  rootUrl: Schema.String,
  patientId: Schema.String,
})

type InstanceConfig = typeof InstanceConfig.Type

const defaultConfig: InstanceConfig = {
  rootUrl: 'https://r2.smarthealthit.org',
  patientId: 'smart-1482713',
}

export { InstanceConfig, defaultConfig }
