import { StyleSheet } from 'react-native'

import { useLocalSearchParams } from 'expo-router'
import ParallaxScrollView from '@/components/parallax-scroll-view'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Fonts } from '@/constants/theme'

import React from 'react'

import { DateTime } from 'effect'
import { Binary } from 'fhir-r4-livestore/resources'
import { binaryById$ } from '@/livestore/queries'
import { useAppStore } from '@/livestore/store'

export default function BinaryDetail(): React.JSX.Element {
  const local = useLocalSearchParams<{ id: string }>()

  const store = useAppStore()
  const binary = store.useQuery(binaryById$(Binary.IdSchema.make(local.id)))
  const dateText = binary?.meta?.lastUpdated
    ? DateTime.formatLocal(binary.meta?.lastUpdated)
    : undefined

  if (!binary) {
    return (
      <ThemedText
        type="title"
        style={{
          fontFamily: Fonts.rounded,
        }}
      >
        Not Found
      </ThemedText>
    )
  }

  return (
    <ParallaxScrollView
      headerBackgroundColor={{ light: '#D0D0D0', unspecified: '#D0D0D0', dark: '#353636' }}
    >
      <ThemedView style={styles.titleContainer}>
        <ThemedText
          type="title"
          style={{
            fontFamily: Fonts.rounded,
          }}
        >
          {binary.meta?.source || 'Binary Record'}
        </ThemedText>
        <ThemedText
          type="subtitle"
          style={{
            fontFamily: Fonts.rounded,
          }}
        >
          {dateText}
        </ThemedText>
      </ThemedView>
      <ThemedText type="default">{binary?.data}</ThemedText>
    </ParallaxScrollView>
  )
}

const styles = StyleSheet.create({
  titleContainer: {
    flexDirection: 'row',
    gap: 8,
  },
})
