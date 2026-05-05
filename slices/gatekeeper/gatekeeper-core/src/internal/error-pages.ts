const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const oauthErrorTitle = (
  kind: 'unsupported_code_challenge' | 'invalid_redirect_uri' | 'invalid_scheme'
): string => {
  if (kind === 'unsupported_code_challenge') return 'Unsupported code challenge method'
  if (kind === 'invalid_redirect_uri') return 'Invalid redirect URI'
  return 'Invalid redirect URI scheme'
}

const oauthErrorBody = (
  kind: 'unsupported_code_challenge' | 'invalid_redirect_uri' | 'invalid_scheme',
  method?: string
): string => {
  if (kind === 'unsupported_code_challenge') {
    let received = ''
    if (method != null) received = ` (received: ${escape(method)})`
    return `Only S256 code_challenge_method is supported${received}.`
  }
  if (kind === 'invalid_redirect_uri') {
    return 'The supplied redirect_uri is not a well-formed URL.'
  }
  return 'The supplied redirect_uri must use http or https.'
}

const oauthErrorHtml = (
  kind: 'unsupported_code_challenge' | 'invalid_redirect_uri' | 'invalid_scheme',
  method?: string
): string => {
  const title = oauthErrorTitle(kind)
  const body = oauthErrorBody(kind, method)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`
}

const pinErrorTitle = (kind: 'invalid_returnTo'): string => {
  if (kind === 'invalid_returnTo') return 'Invalid return URL'
  return 'PIN error'
}

const pinErrorBody = (kind: 'invalid_returnTo'): string => {
  if (kind === 'invalid_returnTo') {
    return 'The supplied returnTo parameter must be a same-origin path beginning with "/".'
  }
  return 'PIN flow failed.'
}

const pinErrorHtml = (kind: 'invalid_returnTo'): string => {
  const title = pinErrorTitle(kind)
  const body = pinErrorBody(kind)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`
}

export { oauthErrorHtml, pinErrorHtml }
