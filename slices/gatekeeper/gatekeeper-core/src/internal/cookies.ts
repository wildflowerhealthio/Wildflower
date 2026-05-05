function parseCookie(cookieHeader: string, name: string): string | null {
  const prefix = `${name}=`
  for (const part of cookieHeader.split('; ')) {
    if (part.startsWith(prefix)) {
      return part.slice(prefix.length)
    }
  }
  return null
}

function buildSessionCookie(token: string, maxAgeSeconds: number): string {
  return `__wildflower_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
}

export { parseCookie, buildSessionCookie }
