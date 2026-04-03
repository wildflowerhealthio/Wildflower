import { Schema } from 'effect'

const LogMessage = Schema.TaggedStruct('Log', {
  log: Schema.String,
})

const ResponseStartMessage = Schema.TaggedStruct('ResponseStart', {
  id: Schema.String,
  url: Schema.String,
  status: Schema.Number,
  statusText: Schema.String,
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
})

const ResponseDataMessage = Schema.TaggedStruct('ResponseData', {
  id: Schema.String,
  data: Schema.Uint8ArrayFromBase64,
})

const ResponseFinishedMessage = Schema.TaggedStruct('ResponseFinished', {
  id: Schema.String,
})

const RequestErrorMessage = Schema.TaggedStruct('RequestError', {
  id: Schema.String,
  url: Schema.String,
  message: Schema.String,
})

const PageLoadedMessage = Schema.TaggedStruct('PageLoaded', {
  url: Schema.String,
  content: Schema.String,
})

const AnyMessage = Schema.Union(
  LogMessage,
  ResponseStartMessage,
  ResponseDataMessage,
  ResponseFinishedMessage,
  RequestErrorMessage,
  PageLoadedMessage
)

export {
  LogMessage,
  ResponseStartMessage,
  ResponseDataMessage,
  ResponseFinishedMessage,
  RequestErrorMessage,
  PageLoadedMessage,
  AnyMessage,
}
