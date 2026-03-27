import { StyleSheet } from 'react-native'

import { useRouter } from 'expo-router'
import ParallaxScrollView from '@/components/parallax-scroll-view'
import { ThemedButton } from '@/components/themed-button'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Fonts } from '@/constants/theme'

import { nanoid } from '@livestore/livestore'
import React from 'react'

import { accounts$ } from 'fhir-r4-livestore/queries'
import { events } from 'fhir-r4-livestore/schema'
import { useAppStore } from '../../../livestore/store'

export default function TabTwoScreen(): React.JSX.Element {
  const router = useRouter()

  const store = useAppStore()
  const accounts = store.useQuery(accounts$)

  const accountAdded = (): void =>
    store.commit(
      events.accountAdded({
        id: nanoid(),
        name: `New ${new Date().toLocaleString()}`,
        addedAt: new Date(),
      })
    )

  return (
    <ParallaxScrollView headerBackgroundColor={{ light: '#D0D0D0', dark: '#353636' }}>
      <ThemedView style={styles.titleContainer}>
        <ThemedText
          type="title"
          style={{
            fontFamily: Fonts.rounded,
          }}
        >
          Sources
        </ThemedText>
      </ThemedView>
      <ThemedText>All connected health data sources</ThemedText>
      {accounts.map((account) => (
        <ThemedView key={account.id} style={{ padding: 10, borderBottomWidth: 1 }}>
          <ThemedText>{account.name}</ThemedText>
          <ThemedText>{account.addedAt?.toLocaleString()}</ThemedText>
        </ThemedView>
      ))}
      <ThemedButton
        title="Add Source"
        onPress={() => {
          accountAdded()
          router.navigate('/add-source-modal')
        }}
      />
    </ParallaxScrollView>
  )
}

const styles = StyleSheet.create({
  headerImage: {
    color: '#808080',
    bottom: -90,
    left: -35,
    position: 'absolute',
  },
  titleContainer: {
    flexDirection: 'row',
    gap: 8,
  },
})
