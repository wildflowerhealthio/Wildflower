// The launch page loads the app's own stylesheet stack, so it is the app's own
// chrome rather than an unstyled interstitial.
import 'fhir-r4-react/app-shell/styles'

import { runSmartLaunchEntry } from 'fhir-r4-react/app-shell'

import { smartConfig } from './config.ts'

void runSmartLaunchEntry({ launch: smartConfig, loadingMessage: 'Launching Medications…' })
