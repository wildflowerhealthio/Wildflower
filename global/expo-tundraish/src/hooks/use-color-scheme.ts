import { useColorScheme as useRNColorScheme } from 'react-native'

/**
 * Safety wrapper around React Native's useColorScheme hook that returns
 * 'unspecified' instead of null or undefined when the color scheme is not
 * available. This allows us to avoid having to check for null or undefined
 * values in our components and instead just check for 'unspecified'.
 */
const useColorScheme = (): 'light' | 'dark' | 'unspecified' => {
  const colorScheme = useRNColorScheme()
  return colorScheme ?? 'unspecified'
}

export { useColorScheme }
