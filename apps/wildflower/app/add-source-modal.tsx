import { Link } from 'expo-router'
import { defaultConfig, FhirR4Remote } from 'fhir-r4-remote'
import React, { useCallback, useMemo, type JSX } from 'react'
import { StyleSheet } from 'react-native'
import { WebView } from 'react-native-webview'

import { type LiveStoreEvent, nanoid } from '@livestore/livestore'
import { DateTime, Either, Match, Schema } from 'effect'
import { Code } from 'fhir-r4-livestore/data-types'
import { Binary, Patient } from 'fhir-r4-livestore/resources'
import { useIntegrationRunner } from '@/hooks/use-integration-runner'
import { events, type schema } from '@/livestore/schema'
import { useAppStore } from '@/livestore/store'
import { ThemedText } from '../components/themed-text'
import { ThemedView } from '../components/themed-view'

export default function AddSourceModalScreen(): JSX.Element {
  const webRef = React.useRef<WebView>(null)

  const store = useAppStore()

  const handleEntityReceived: ConstructorParameters<typeof FhirR4Remote>[1] = useCallback(
    (entity) => {
      const binaryId = Binary.IdSchema.make(nanoid())
      const dbEvents: LiveStoreEvent.Input.ForSchema<typeof schema>[] = [
        events.binaryReceived({
          id: binaryId,
          contentType: Code.make(entity.contentType),
          data: entity.body,
          source: entity.url,
          addedAt: DateTime.unsafeNow(),
        }),
      ]

      entity.parse().pipe(
        Either.match({
          onLeft: (err) => {
            console.error('Failed to parse entity', { entity, error: err })
          },
          onRight: (parsed) => {
            for (const resource of parsed.resources) {
              Match.value(resource).pipe(
                Match.when(Schema.is(Patient.WithId), (patient) => {
                  dbEvents.push(events.patientReceived({ patient }))
                })
              )
            }
          },
        })
      )

      store.commit(...dbEvents)
    },
    [store]
  )

  const remote = useMemo(
    () => new FhirR4Remote(defaultConfig, handleEntityReceived),
    [handleEntityReceived]
  )

  const webViewProps = useIntegrationRunner({
    remote,
    webRef,
    onError: ({ id, url, message }) => {
      console.error(`Error in sniffer request ${id} for ${url}: ${message}`)
    },
  })

  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title">Add a source</ThemedText>
      <WebView
        ref={webRef}
        containerStyle={styles.webview}
        onError={(err) => {
          console.error(err)
        }}
        {...webViewProps}
      ></WebView>
      <Link href="/" dismissTo style={styles.link}>
        <ThemedText type="link">Go to home screen</ThemedText>
      </Link>
    </ThemedView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  webview: {
    width: '100%',
    height: 0,
    flex: 1,
    margin: 0,
  },
  link: {
    marginTop: 15,
    paddingVertical: 15,
  },
})
