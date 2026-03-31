import { StyleSheet } from 'react-native'

import { useLocalSearchParams } from 'expo-router'
import ParallaxScrollView from '@/components/parallax-scroll-view'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Fonts } from '@/constants/theme'

import React from 'react'

import { patientById$ } from 'fhir-r4-livestore/queries'
import { Patient } from 'fhir-r4-livestore/resources'
import { useAppStore } from '../../../livestore/store'

export default function PatientDetail(): React.JSX.Element {
  const local = useLocalSearchParams<{ id: string }>()

  const store = useAppStore()
  const patient = store.useQuery(patientById$(Patient.IdSchema.make(local.id)))

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
          {patient?.name?.[0]?.text}
        </ThemedText>
      </ThemedView>
      <ThemedText type="default">{JSON.stringify(patient, null, 2)}</ThemedText>
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
