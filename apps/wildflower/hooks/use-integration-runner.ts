import { Either, Match, Schema } from 'effect'
import { useCallback, useMemo } from 'react'
import type { WebView, WebViewProps } from 'react-native-webview'
import type {
  WebViewMessageEvent,
  WebViewProgressEvent,
} from 'react-native-webview/lib/WebViewTypes'
import type { Remote } from 'remote-entities'

import type { Binary, Patient } from 'fhir-r4-livestore/resources'
import { AnyMessage } from '@/browser-sniffer/messages'
import snifferScript from '@/browser-sniffer/sniffer-text'

const decodeMessage = Schema.decodeUnknownEither(Schema.parseJson(AnyMessage))

type AllResources = typeof Binary.WithId.Type | typeof Patient.WithId.Type

interface UseIntegrationRunnerOptions {
  remote: Remote.Remote<AllResources>
  webRef: React.RefObject<WebView | null>
  onError?: (error: { id: string; url: string; message: string }) => void
}

function useIntegrationRunner({
  remote,
  webRef,
  onError,
}: UseIntegrationRunnerOptions): Pick<
  WebViewProps,
  'source' | 'injectedJavaScriptBeforeContentLoaded' | 'onMessage' | 'onLoadProgress'
> {
  const source = useMemo(() => remote.firstPage, [remote])

  const handleMessage = useCallback(
    (msg: typeof AnyMessage.Type) => {
      Match.type<typeof AnyMessage.Type>().pipe(
        Match.tag('Log', (event) => {
          console.log('Log message from WebView', { log: event.log })
        }),
        Match.tag('ResponseStart', (event) => {
          if (!remote.shouldKeepResponse(event)) {
            webRef.current?.injectJavaScript(
              `window.cancelSnifferRequest(${JSON.stringify(event.id)})`
            )
          }
        }),
        Match.tag('ResponseData', (event) => {
          remote.handleResponseData(event)
        }),
        Match.tag('ResponseFinished', (event) => {
          remote.handleResponseFinished(event)
        }),
        Match.tag('RequestError', (event) => {
          if (onError) {
            onError({ id: event.id, url: event.url, message: event.message })
          } else {
            console.warn('Request error from WebView', {
              id: event.id,
              url: event.url,
              message: event.message,
            })
          }
        }),
        Match.tag('PageLoaded', (event) => {
          console.log('Page loaded in WebView', { url: event.url })
        }),
        Match.exhaustive
      )(msg)
    },
    [onError, webRef, remote]
  )

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const msgEither = decodeMessage(event.nativeEvent.data)
      Either.match(msgEither, {
        onLeft(err) {
          console.warn('Failed to decode message from WebView', {
            error: err,
            data: event.nativeEvent.data,
          })
        },
        onRight(msg) {
          handleMessage(msg)
        },
      })
    },
    [handleMessage]
  )

  const onLoadProgress = useCallback(
    (_event: WebViewProgressEvent) => {
      webRef.current?.injectJavaScript(snifferScript)
    },
    [webRef]
  )

  return {
    source,
    injectedJavaScriptBeforeContentLoaded: snifferScript,
    onMessage,
    onLoadProgress,
  }
}

export { useIntegrationRunner }
export type { UseIntegrationRunnerOptions }
