import './instrument.ts'
import { MemoryRouter } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { renderApp } from './app-root.tsx'
import './styles/global.css'

renderApp({ Router: MemoryRouter, entry: 'main-embedded' })
