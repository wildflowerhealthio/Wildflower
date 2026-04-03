import type { Binary, Patient } from 'fhir-r4-livestore/resources'
import { type Entity, Remote, type Source } from 'remote-entities'

import type { InstanceConfig } from './config.ts'
import { PatientEntity } from './entities/patient-entity.ts'

type AnyResource = typeof Binary.WithId.Type | typeof Patient.WithId.Type

class FhirR4Remote extends Remote.Remote<AnyResource> {
  public override readonly firstPage: Source.Uri | Source.Html
  public override readonly name: string = 'FHIR R4 Remote'
  protected override readonly remoteEntityConstructors: readonly Entity.RemoteEntityConstructor<AnyResource>[] =
    [PatientEntity]
  constructor(
    config: InstanceConfig,
    handleEntityReceived: (entity: Entity.RemoteEntity<AnyResource>) => void
  ) {
    super(handleEntityReceived)
    const patientUrl = `${config.rootUrl}/Patient/${config.patientId}?_format=json`
    const safePatientUrl = patientUrl
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
    const jsPatientUrl = JSON.stringify(patientUrl)
    this.firstPage = {
      html: `
      <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <title>FHIR Resource Loader</title>
          </head>
          <body>
            <h1>Patient data from ${safePatientUrl}</h1>
            <h2 id="h2">Loading...</h2>
            <script>setTimeout(() => {
              document.getElementById('h2').innerText = "Fetching";
              fetch(${jsPatientUrl})
                .then(res => res.text())
                .then(text => {
                  document.getElementById('h2').innerText = text;
                })
                .catch(err => {
                  document.getElementById('h2').innerText = String(err);
                });
            }, 500);</script>
          </body>
        </html>
      `,
    }
  }
}

export { FhirR4Remote }
