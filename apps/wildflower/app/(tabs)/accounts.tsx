import { useRouter } from 'expo-router'
import { ThemedButton } from '@/components/themed-button'

import React from 'react'

import { DateTime } from 'effect'
import { type Href } from 'expo-router'
import { Alert, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import ItemList from '@/components/ui/item-list'
import { useThemeColor } from '@/hooks/use-theme-color'
import { remotes$ } from '@/livestore/queries'
import { events, RemoteIdSchema } from '@/livestore/schema'
import { useAppStore } from '@/livestore/store'

export default function AccountList(): React.JSX.Element {
  const router = useRouter()
  const store = useAppStore()
  const remotes = store.useQuery(remotes$)
  const iconColor = useThemeColor({}, 'icon')

  return (
    <SafeAreaView style={{ flex: 1 }}>
      {remotes.length === 0 ? (
        <Text style={[styles.emptyText, { color: iconColor }]}>
          No accounts configured. Add one to get started.
        </Text>
      ) : (
        <ItemList
          title="Accounts"
          actions={[
            { key: 'edit', label: 'Edit', systemImage: 'pencil' },
            { key: 'import', label: 'Import Now', systemImage: 'arrow.down.circle' },
            { key: 'delete', label: 'Delete', role: 'destructive', systemImage: 'trash' },
          ]}
          onAction={(actionKey, item) => {
            if (actionKey === 'edit') {
              router.navigate({
                pathname: '/account-config-modal',
                params: { accountId: item.id },
              })
            } else if (actionKey === 'import') {
              router.navigate({
                pathname: '/run-sync-modal',
                params: { accountId: item.id },
              })
            } else if (actionKey === 'delete') {
              const remote = remotes.find((r) => r.id === item.id)
              if (!remote) return
              Alert.alert('Delete Account', `Are you sure you want to delete "${remote.name}"?`, [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: (): void => {
                    store.commit(events.remoteDeleted({ id: RemoteIdSchema.make(remote.id) }))
                  },
                },
              ])
            }
          }}
          items={remotes.map((remote) => ({
            id: remote.id,
            title: remote.name,
            destination: `/account-config-modal?accountId=${remote.id}` as Href,
            subtitle: `${remote.config._tag.toUpperCase()} · ${remote.config.rootUrl}\nAdded ${DateTime.formatLocal(remote.addedAt)}`,
          }))}
        />
      )}
      <View style={styles.footer}>
        <ThemedButton
          title="Add Account"
          onPress={() => router.navigate('/account-config-modal')}
        />
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
    marginTop: 'auto',
    marginBottom: 'auto',
  },
  footer: {
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#ccc',
  },
})
