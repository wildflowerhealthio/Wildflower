import { useLocalSearchParams, useRouter } from 'expo-router'
import { defaultConfig, type InstanceConfig } from 'fhir-r4-remote'
import React, { useState, type JSX } from 'react'
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

import { nanoid } from '@livestore/livestore'
import { DateTime } from 'effect'
import { ThemedButton } from '@/components/themed-button'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { useThemeColor } from '@/hooks/use-theme-color'
import { remotes$ } from '@/livestore/queries'
import { events, RemoteIdSchema } from '@/livestore/schema'
import { useAppStore } from '@/livestore/store'

function camelToTitle(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim()
}

const instanceConfigFieldKeys: readonly (keyof typeof InstanceConfig.fields)[] = [
  'rootUrl',
  'patientId',
]

export default function AccountConfigModalScreen(): JSX.Element {
  const { accountId } = useLocalSearchParams<{ accountId?: string }>()
  const router = useRouter()
  const store = useAppStore()
  const textColor = useThemeColor({}, 'text')
  const iconColor = useThemeColor({}, 'icon')

  const allRemotes = store.useQuery(remotes$)
  const existing = accountId ? allRemotes.find((r) => r.id === accountId) : undefined

  const [name, setName] = useState(existing?.name ?? '')
  const _tag = 'fhir-r4' as const
  const [rootUrl, setRootUrl] = useState(existing?.config.rootUrl ?? defaultConfig.rootUrl)
  const [patientId, setPatientId] = useState(existing?.config.patientId ?? defaultConfig.patientId)

  const configFields = {
    _tag: { value: _tag, onChange: () => {} },
    rootUrl: { value: rootUrl, onChange: setRootUrl },
    patientId: { value: patientId, onChange: setPatientId },
  } as const

  const handleSave = (): void => {
    const remoteName = name || `FHIR R4 ${new Date().toLocaleDateString()}`

    if (existing && accountId) {
      store.commit(
        events.remoteUpdated({
          id: RemoteIdSchema.make(accountId),
          name: remoteName,
          config: {
            _tag,
            rootUrl,
            patientId,
          },
        })
      )
    } else {
      store.commit(
        events.remoteAdded({
          id: RemoteIdSchema.make(nanoid()),
          name: remoteName,
          config: {
            _tag,
            rootUrl,
            patientId,
          },
          addedAt: DateTime.unsafeNow(),
        })
      )
    }

    router.dismiss()
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <ThemedText type="title">{existing ? 'Edit Account' : 'Add Account'}</ThemedText>

        <View style={styles.field}>
          <Text style={[styles.label, { color: iconColor }]}>Type</Text>
          <View style={[styles.typeBadge, { borderColor: iconColor }]}>
            <Text style={[styles.typeText, { color: textColor }]}>FHIR R4</Text>
          </View>
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: iconColor }]}>Name</Text>
          <TextInput
            style={[styles.input, { color: textColor, borderColor: iconColor }]}
            value={name}
            onChangeText={setName}
            placeholder="Account name"
            placeholderTextColor={iconColor}
          />
        </View>

        {instanceConfigFieldKeys.map((key) => (
          <View key={key} style={styles.field}>
            <Text style={[styles.label, { color: iconColor }]}>{camelToTitle(key)}</Text>
            <TextInput
              style={[styles.input, { color: textColor, borderColor: iconColor }]}
              value={configFields[key].value}
              onChangeText={configFields[key].onChange}
              placeholder={camelToTitle(key)}
              placeholderTextColor={iconColor}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        ))}

        <View style={styles.buttons}>
          <ThemedButton title="Save" onPress={handleSave} />
          <ThemedButton title="Cancel" onPress={() => router.dismiss()} />
        </View>
      </ScrollView>
    </ThemedView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    gap: 16,
  },
  field: {
    gap: 4,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  typeBadge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    alignSelf: 'flex-start',
  },
  typeText: {
    fontSize: 16,
    fontWeight: '500',
  },
  buttons: {
    gap: 12,
    marginTop: 8,
  },
})
