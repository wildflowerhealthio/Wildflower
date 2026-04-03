import { useRouter } from 'expo-router'
import { ThemedButton } from '@/components/themed-button'

import React from 'react'

import { DateTime } from 'effect'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useThemeColor } from '@/hooks/use-theme-color'
import { remotes$ } from '@/livestore/queries'
import { events, RemoteIdSchema } from '@/livestore/schema'
import { useAppStore } from '../../../livestore/store'

export default function AccountList(): React.JSX.Element {
  const router = useRouter()
  const store = useAppStore()
  const remotes = store.useQuery(remotes$)
  const iconColor = useThemeColor({}, 'icon')
  const tintColor = useThemeColor({}, 'tint')

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scroll}>
        <Text style={[styles.sectionTitle, { color: iconColor }]}>Accounts</Text>
        {remotes.map((remote, index) => (
          <View
            key={remote.id}
            style={[styles.row, index < remotes.length - 1 && styles.rowBorder]}
          >
            <View style={styles.rowContent}>
              <Text style={[styles.rowTitle, { color: tintColor }]}>{remote.name}</Text>
              <Text style={[styles.rowSubtitle, { color: iconColor }]}>
                {remote.config._tag.toUpperCase()} · {remote.config.rootUrl}
              </Text>
              <Text style={[styles.rowSubtitle, { color: iconColor }]}>
                Added {DateTime.formatLocal(remote.addedAt)}
              </Text>
            </View>
            <View style={styles.actions}>
              <Pressable
                style={[styles.actionButton, { borderColor: tintColor }]}
                onPress={() =>
                  router.navigate({
                    pathname: '/run-sync-modal',
                    params: { accountId: remote.id },
                  })
                }
              >
                <Text style={[styles.actionText, { color: tintColor }]}>Import Now</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, { borderColor: iconColor }]}
                onPress={() =>
                  router.navigate({
                    pathname: '/account-config-modal',
                    params: { accountId: remote.id },
                  })
                }
              >
                <Text style={[styles.actionText, { color: iconColor }]}>Edit</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, styles.deleteButton]}
                onPress={() =>
                  store.commit(events.remoteDeleted({ id: RemoteIdSchema.make(remote.id) }))
                }
              >
                <Text style={styles.deleteText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ))}
        {remotes.length === 0 && (
          <Text style={[styles.emptyText, { color: iconColor }]}>
            No accounts configured. Add one to get started.
          </Text>
        )}
      </ScrollView>
      <View style={styles.footer}>
        <ThemedButton
          title="Add Account"
          onPress={() => router.navigate('/account-config-modal')}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    flex: 1,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  row: {
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ccc',
  },
  rowContent: {
    gap: 2,
    marginBottom: 8,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '500',
  },
  rowSubtitle: {
    fontSize: 13,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  actionText: {
    fontSize: 13,
    fontWeight: '500',
  },
  deleteButton: {
    borderColor: '#c33',
  },
  deleteText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#c33',
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
    marginTop: 32,
  },
  footer: {
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#ccc',
  },
})
