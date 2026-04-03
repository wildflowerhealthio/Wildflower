import { Schema } from 'effect'

const InstanceConfig = Schema.TaggedStruct('fhir-r4', {
  rootUrl: Schema.String,
  patientId: Schema.String,
})

type InstanceConfig = typeof InstanceConfig.Type

const defaultConfig: InstanceConfig = {
  _tag: 'fhir-r4',
  rootUrl: 'https://r2.smarthealthit.org',
  patientId: 'smart-1482713',
}

export { InstanceConfig, defaultConfig }
