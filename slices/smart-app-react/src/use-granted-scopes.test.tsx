import { cleanup, render, screen } from '@testing-library/react'
import { SmartRuntimeContext } from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  stubConnection,
  stubSmartRuntime,
} from '@wildflowerhealthio/fhir-r4-react/smart/test-helpers'
import { Scope } from '@wildflowerhealthio/scopes-core'
import type { JSX } from 'react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { useGrantedScopes } from './use-granted-scopes.ts'

afterEach(cleanup)

/** A child that lists the scopes its page was granted. */
function GrantedScopes(): JSX.Element {
  return (
    <ul>
      {useGrantedScopes().map((scope) => (
        <li key={scope.serialize() ?? scope.kind}>{scope.serialize()}</li>
      ))}
    </ul>
  )
}

describe('useGrantedScopes', () => {
  it('should read the scopes the connection under the gate was granted', () => {
    // Arrange
    const grantedScopes = [Scope.parse('openid'), Scope.parse('patient/Observation.rs')]
    const { runtime } = stubSmartRuntime({}, stubConnection({ grantedScopes }))

    // Act
    render(
      <SmartRuntimeContext value={runtime}>
        <GrantedScopes />
      </SmartRuntimeContext>
    )

    // Assert
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'openid',
      'patient/Observation.rs',
    ])
  })
})
