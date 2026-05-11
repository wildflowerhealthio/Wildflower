import { Schema } from 'effect'

const InstanceConfig = Schema.TaggedStruct('fhir-r4', {
  rootUrl: Schema.String,
  patientId: Schema.String,
})

type InstanceConfig = typeof InstanceConfig.Type

const defaultConfig: InstanceConfig = {
  _tag: 'fhir-r4',
  rootUrl: 'https://r4.smarthealthit.org',
  patientId: '8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882',
}

export { InstanceConfig, defaultConfig }
