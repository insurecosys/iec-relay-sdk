import { describe, it, expect } from 'vitest'
import { mintServiceJwt, isTokenExpired } from './jwt.js'

const TEST_SECRET = 'test-secret-key-for-unit-tests-abc'  // 34 chars (>= 32)

describe('mintServiceJwt', () => {
  it('produces a valid 3-part JWT string', () => {
    const token = mintServiceJwt(TEST_SECRET, 'test-org')
    const parts = token.split('.')
    expect(parts).toHaveLength(3)
  })

  it('includes correct header', () => {
    const token = mintServiceJwt(TEST_SECRET, 'test-org')
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' })
  })

  it('includes iss, programId and scopes in payload', () => {
    const token = mintServiceJwt(TEST_SECRET, 'my-service')
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    expect(payload.iss).toBe('iec-relay:my-service')
    expect(payload.programId).toBe('my-service')
    expect(payload.scopes).toEqual(['service:relay'])
    expect(payload.iat).toBeTypeOf('number')
    expect(payload.exp).toBeTypeOf('number')
  })

  it('respects custom TTL', () => {
    const token = mintServiceJwt(TEST_SECRET, 'test-org', 60)
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    expect(payload.exp - payload.iat).toBe(60)
  })

  it('defaults to 300s TTL', () => {
    const token = mintServiceJwt(TEST_SECRET, 'test-org')
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    expect(payload.exp - payload.iat).toBe(300)
  })

  it('produces different signatures for different secrets', () => {
    const secretA = 'aaaa-secret-key-for-testing-sig-a'
    const secretB = 'bbbb-secret-key-for-testing-sig-b'
    const token1 = mintServiceJwt(secretA, 'test-org')
    const token2 = mintServiceJwt(secretB, 'test-org')
    expect(token1.split('.')[2]).not.toBe(token2.split('.')[2])
  })

  it('rejects secrets shorter than 32 characters', () => {
    expect(() => mintServiceJwt('too-short', 'test-org')).toThrow('at least 32 characters')
    expect(() => mintServiceJwt('', 'test-org')).toThrow('at least 32 characters')
  })
})

describe('isTokenExpired', () => {
  it('returns false for a fresh token', () => {
    const token = mintServiceJwt(TEST_SECRET, 'test-org', 300)
    expect(isTokenExpired(token)).toBe(false)
  })

  it('returns true for a token expiring within the buffer', () => {
    const token = mintServiceJwt(TEST_SECRET, 'test-org', 10)
    expect(isTokenExpired(token, 15)).toBe(true)
  })

  it('returns true for malformed tokens', () => {
    expect(isTokenExpired('not-a-jwt')).toBe(true)
    expect(isTokenExpired('')).toBe(true)
    expect(isTokenExpired('a.b')).toBe(true)
  })

  it('returns false when buffer is 0 and token is not expired', () => {
    const token = mintServiceJwt(TEST_SECRET, 'test-org', 300)
    expect(isTokenExpired(token, 0)).toBe(false)
  })
})
