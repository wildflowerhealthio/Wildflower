import { type Entity, Remote, type Source } from 'collector-core'
import type { Binary, Observation, Patient } from 'emr-core/livestore'

import type { InstanceConfig } from './config.ts'
import { ObservationListEntity } from './entities/observation-list-entity.ts'
import { PatientEntity } from './entities/patient-entity.ts'

type AnyResource =
  | typeof Binary.RowSchemaNullableId.Type
  | typeof Patient.RowSchemaNullableId.Type
  | typeof Observation.RowSchemaNullableId.Type

class FhirR4Remote extends Remote.Remote<AnyResource> {
  public override readonly firstPage: Source.Uri | Source.Html
  public override readonly name: string = 'FHIR R4 Remote'
  protected override readonly remoteEntityConstructors: readonly Entity.RemoteEntityConstructor<AnyResource>[] =
    [PatientEntity, ObservationListEntity]
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

    const jsObservationUrl = `${config.rootUrl}/Observation?subject%3APatient=${config.patientId}&_count=250&_format=json`

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
            <button style="padding: 2em; font-size: 3em" onclick="fetch('${jsObservationUrl}').then(res => res.json()).then(data => console.log(data)).catch(err => alert(String(err)))">
              Fetch Observations
            </button>
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
