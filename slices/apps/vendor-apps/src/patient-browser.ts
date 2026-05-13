import { assets, type AssetEntry } from './generated-patient-browser.ts'

const PREFIX = '/apps/patient-browser/'

const lookupAsset = (pathname: string): AssetEntry | undefined => {
  if (!pathname.startsWith(PREFIX)) return undefined
  let rel = pathname.slice(PREFIX.length)
  if (rel === '' || rel.endsWith('/')) {
    rel = `${rel}index.html`
  }
  return assets[rel]
}

export { assets, lookupAsset, PREFIX }
export type { AssetEntry }
