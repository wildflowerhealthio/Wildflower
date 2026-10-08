import { Option } from 'effect'
import { type JSX, useMemo, useState } from 'react'
import { GrantDraft, ScopeRequest } from 'scopes-core'
import { ScopePicker } from 'scopes-react'
import { ConsentApproval, ConsentDetails } from 'servers-core'

import { ConsentFormLayout, type ConsentFormProps } from './consent-form-layout.tsx'

/**
 * A device's pairing as the sheet asks it: the device and its pairing code,
 * the access it asked for in plain words, which the Owner may narrow or
 * widen up to its client's registration, and Deny or Allow.
 */
function DeviceConsentForm(props: ConsentFormProps<ConsentDetails.Device>): JSX.Element {
  const { details } = props
  const request = useMemo(
    () =>
      ScopeRequest.expandable({
        requested: details.requestedScopes,
        available: details.registeredScopes,
      }),
    [details]
  )
  const [draft, setDraft] = useState(() => GrantDraft.fromScopes(details.requestedScopes, null))
  return (
    <ConsentFormLayout
      {...props}
      requestLines={
        <>
          {details.deviceName.pipe(
            Option.map((deviceName) => (
              <p key="device-name">
                from the device <code>{deviceName}</code>
              </p>
            )),
            Option.getOrNull
          )}
          <p>
            pairing code <code>{details.userCode}</code>
          </p>
        </>
      }
      canAllow={GrantDraft.hasScopes(draft)}
      approval={() => ConsentApproval.ofDevice(details, GrantDraft.serializeAll(draft))}
    >
      <ScopePicker
        subjectName={ConsentDetails.appNameOf(details)}
        request={request}
        draft={draft}
        onDraftChange={setDraft}
        mode="expandable"
        phrasing="asking"
        forcedSubject="system"
      />
    </ConsentFormLayout>
  )
}

export { DeviceConsentForm }
