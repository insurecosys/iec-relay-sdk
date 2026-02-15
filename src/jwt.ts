import { createHmac } from 'node:crypto'

interface JwtPayload {
  programId: string
  scopes: string[]
  iat: number
  exp: number
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input
  return buf.toString('base64url')
}

/**
 * Mint a short-lived HS256 JWT for service-to-service auth through Janus.
 * Uses only Node.js built-in crypto — zero dependencies.
 */
export function mintServiceJwt(
  secret: string,
  programId: string,
  ttlSeconds: number = 300,
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)

  const payload: JwtPayload = {
    programId,
    scopes: ['service:relay'],
    iat: now,
    exp: now + ttlSeconds,
  }

  const encodedPayload = base64url(JSON.stringify(payload))
  const signature = createHmac('sha256', secret)
    .update(`${header}.${encodedPayload}`)
    .digest('base64url')

  return `${header}.${encodedPayload}.${signature}`
}

/**
 * Check if a JWT is expired or will expire within the given buffer (seconds).
 */
export function isTokenExpired(token: string, bufferSeconds: number = 30): boolean {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return true

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    const now = Math.floor(Date.now() / 1000)

    return payload.exp <= now + bufferSeconds
  } catch {
    return true
  }
}
