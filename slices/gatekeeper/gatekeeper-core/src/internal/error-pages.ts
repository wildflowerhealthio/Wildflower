type OAuthErrorKind = 'unsupported_code_challenge' | 'invalid_redirect_uri' | 'invalid_scheme'
type PinErrorKind = 'invalid_returnTo'

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const oauthErrorMessage: Record<OAuthErrorKind, { title: string; body: string }> = {
  unsupported_code_challenge: {
    title: 'Unsupported code challenge method',
    body: 'Only S256 code_challenge_method is supported',
  },
  invalid_redirect_uri: {
    title: 'Invalid redirect URI',
    body: 'The supplied redirect_uri is not a well-formed URL.',
  },
  invalid_scheme: {
    title: 'Invalid redirect URI scheme',
    body: 'The supplied redirect_uri must use http or https.',
  },
}

const pinErrorMessage: Record<PinErrorKind, { title: string; body: string }> = {
  invalid_returnTo: {
    title: 'Invalid return URL',
    body: 'The supplied returnTo parameter must be a same-origin path beginning with "/".',
  },
}

const renderErrorHtml = (title: string, body: string): string =>
  `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
</head>
<body>
  <h1>${title}</h1>
  <p>${body}</p>
</body>
</html>`

const oauthErrorHtml = (kind: OAuthErrorKind, method?: string): string => {
  const { title, body } = oauthErrorMessage[kind]
  let suffix = ''
  if (kind === 'unsupported_code_challenge' && method != null) {
    suffix = ` (received: ${escape(method)})`
  }
  return renderErrorHtml(title, `${body}${suffix}.`)
}

const pinErrorHtml = (kind: PinErrorKind): string => {
  const { title, body } = pinErrorMessage[kind]
  return renderErrorHtml(title, body)
}

export { oauthErrorHtml, pinErrorHtml }
