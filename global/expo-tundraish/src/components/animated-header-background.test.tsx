import { render } from '@testing-library/react-native'

// This is the proper way to mock react-native-worklets, but it causes the test
// suite to fail with a "ReferenceError: regeneratorRuntime is not defined"
// error. The workaround is to import the unmocked version
// of react-native-worklets, which is what we do in the test file itself.
// jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'))

import { AnimatedHeaderBackground } from './animated-header-background'

describe('AnimatedHeaderBackground', () => {
  it.each([[false], [true]] as const)('renders without crashing when active=%s', (active) => {
    const { unmount } = render(
      <AnimatedHeaderBackground
        cardColor="#fff"
        warningColor="#ffaa00"
        borderColor="#ccc"
        active={active}
      />
    )
    unmount()
  })

  it('survives an active toggle without throwing', () => {
    const { rerender, unmount } = render(
      <AnimatedHeaderBackground
        cardColor="#fff"
        warningColor="#ffaa00"
        borderColor="#ccc"
        active={false}
      />
    )
    rerender(
      <AnimatedHeaderBackground
        cardColor="#fff"
        warningColor="#ffaa00"
        borderColor="#ccc"
        active={true}
      />
    )
    rerender(
      <AnimatedHeaderBackground
        cardColor="#fff"
        warningColor="#ffaa00"
        borderColor="#ccc"
        active={false}
      />
    )
    unmount()
  })
})
