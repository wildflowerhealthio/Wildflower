import './instrument.ts'
import { BrowserRouter } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { renderApp } from './app-root.tsx'
import './styles/global.css'

renderApp({ Router: BrowserRouter, entry: 'main-web' })
