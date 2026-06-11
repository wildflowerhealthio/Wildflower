type OAuthErrorKind =
  | 'unsupported_response_type'
  | 'unsupported_code_challenge'
  | 'invalid_redirect_uri'
  | 'invalid_scheme'
  | 'unknown_client'
  | 'disabled_client'
  | 'redirect_uri_not_allowed'
  | 'scope_not_allowed'

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const oauthErrorMessage: Record<OAuthErrorKind, { title: string; body: string }> = {
  unsupported_response_type: {
    title: 'Unsupported response type',
    body: 'Only the authorization code flow (response_type=code) is supported',
  },
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
  unknown_client: {
    title: 'Unknown client',
    body: 'The supplied client_id is not registered.',
  },
  disabled_client: {
    title: 'Disabled client',
    body: 'The supplied client_id has been disabled.',
  },
  redirect_uri_not_allowed: {
    title: 'Redirect URI not allowed',
    body: 'The supplied redirect_uri is not registered for this client.',
  },
  scope_not_allowed: {
    title: 'Scope not allowed',
    body: 'One or more requested scopes are not permitted for this client.',
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

const oauthErrorHtml = (kind: OAuthErrorKind, received?: string): string => {
  const { title, body } = oauthErrorMessage[kind]
  let suffix = ''
  if (
    (kind === 'unsupported_code_challenge' || kind === 'unsupported_response_type') &&
    received != null
  ) {
    suffix = ` (received: ${escape(received)})`
  }
  return renderErrorHtml(title, `${body}${suffix}.`)
}

export { oauthErrorHtml }
