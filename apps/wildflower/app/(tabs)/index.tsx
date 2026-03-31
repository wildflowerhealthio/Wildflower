import { StyleSheet } from 'react-native'

import { type JSX } from 'react'
import ParallaxScrollView from '../../components/parallax-scroll-view'
import { ThemedText } from '../../components/themed-text'
import { ThemedView } from '../../components/themed-view'

export default function HomeScreen(): JSX.Element {
  return (
    <ParallaxScrollView
      headerBackgroundColor={{ light: '#A1CEDC', unspecified: '#A1CEDC', dark: '#1D3D47' }}
      // headerImage={
      //   <Image source={require('../../assets/partial-react-logo.png')} style={styles.reactLogo} />
      // }
    >
      <ThemedView style={styles.titleContainer}>
        <ThemedText type="title">Welcome!</ThemedText>
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <ThemedText type="subtitle">Step 1: Add accounts, and pull in data</ThemedText>
        <ThemedText>Visit the account tab</ThemedText>
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <ThemedText type="subtitle">Step 2: View raw data</ThemedText>
        <ThemedText>In the Records tab</ThemedText>
      </ThemedView>
    </ParallaxScrollView>
  )
}

const styles = StyleSheet.create({
  titleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stepContainer: {
    gap: 8,
    marginBottom: 8,
  },
  reactLogo: {
    height: 178,
    width: 290,
    bottom: 0,
    left: 0,
    position: 'absolute',
  },
})
