import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import golden from '../../servers-wire-golden.json' with { type: 'json' }
import * as CertificateOrderRequestError from './certificate-order-request-error.ts'
import { HostAnswerUndecodable, HostCommandFailed } from './host-commands.ts'

describe('CertificateOrderRequestError.refusalOf', () => {
  it.each(golden.certificateOrderRequestErrors)(
    "should read the host's $kind refusal as its kind, or none for the registry's",
    (error) => {
      // Act
      const refusal = CertificateOrderRequestError.refusalOf(
        new HostCommandFailed({ command: 'server_force_new_certificate', cause: error })
      )

      // Assert
      expect(refusal).toEqual(
        error.kind === 'notRegistered' ? Option.none() : Option.some(error.kind)
      )
    }
  )

  it('should read a failure that is no refusal as none', () => {
    expect(
      CertificateOrderRequestError.refusalOf(
        new HostCommandFailed({ command: 'server_order_certificate', cause: 'IPC unavailable' })
      )
    ).toEqual(Option.none())
    expect(
      CertificateOrderRequestError.refusalOf(
        new HostAnswerUndecodable({ command: 'server_order_certificate', cause: 'not null' })
      )
    ).toEqual(Option.none())
  })
})
