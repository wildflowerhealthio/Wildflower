// The launch page loads the app's own stylesheet stack, so it is the app's own
// chrome rather than an unstyled interstitial.
import 'react-tundraish/styles'

import { runSmartLaunchEntry } from 'smart-app-react'

import { smartConfig } from './config.ts'

void runSmartLaunchEntry({ launch: smartConfig, loadingMessage: 'Launching Medications…' })
