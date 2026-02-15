import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RelayClient, RelayError } from './client.js'

const TEST_SECRET = '370e0b7a6c0f59b8979701ad239fda3cfafb1ce0215e70497b8ddea2f7ba44ee'

describe('RelayClient constructor', () => {
  it('requires jwtSecret or relayUrl', () => {
    expect(() => new RelayClient({})).toThrow('Either jwtSecret')
  })

  it('requires programId when using jwtSecret', () => {
    expect(() => new RelayClient({ jwtSecret: TEST_SECRET })).toThrow('programId is required')
  })

  it('accepts jwtSecret + programId', () => {
    const client = new RelayClient({ jwtSecret: TEST_SECRET, programId: 'test-org' })
    expect(client).toBeInstanceOf(RelayClient)
  })

  it('accepts relayUrl for direct mode', () => {
    const client = new RelayClient({ relayUrl: 'http://localhost:3001' })
    expect(client).toBeInstanceOf(RelayClient)
  })
})

describe('RelayClient.fromEnv', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('creates client from RELAY_DIRECT_URL', () => {
    process.env.RELAY_DIRECT_URL = 'http://localhost:3001'
    const client = RelayClient.fromEnv()
    expect(client).toBeInstanceOf(RelayClient)
  })

  it('creates client from JWT_SECRET + PROGRAM_ID', () => {
    process.env.JWT_SECRET = TEST_SECRET
    process.env.PROGRAM_ID = 'test-org'
    const client = RelayClient.fromEnv()
    expect(client).toBeInstanceOf(RelayClient)
  })

  it('throws when no env vars are set', () => {
    delete process.env.RELAY_DIRECT_URL
    delete process.env.JWT_SECRET
    expect(() => RelayClient.fromEnv()).toThrow('Set JWT_SECRET')
  })
})

describe('RelayClient.sendEmail', () => {
  let client: RelayClient

  beforeEach(() => {
    client = new RelayClient({
      jwtSecret: TEST_SECRET,
      programId: 'test-org',
      janusUrl: 'https://janus.test.local',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws RelayError when recipient has no email', async () => {
    await expect(
      client.sendEmail({
        template: 'welcome',
        to: { name: 'Test' },
        data: { firstName: 'Test' },
      }),
    ).rejects.toThrow(RelayError)
  })

  it('throws RelayError for invalid email format', async () => {
    await expect(
      client.sendEmail({
        template: 'welcome',
        to: { email: 'not-an-email' },
        data: {},
      }),
    ).rejects.toThrow('Valid recipient email')
  })

  it('handles non-JSON error responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    } as unknown as Response)

    await expect(
      client.sendEmail({
        template: 'welcome',
        to: { email: 'test@test.com' },
        data: {},
      }),
    ).rejects.toThrow('non-JSON body')
  })

  it('sends email with correct request body', async () => {
    const mockResponse = {
      success: true,
      data: {
        messageId: 'msg-123',
        channel: 'email',
        status: 'sent',
        providerMessageId: 'sg-456',
      },
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockResponse),
    } as Response)

    const result = await client.sendEmail({
      template: 'welcome',
      to: { email: 'user@example.com', name: 'Jane' },
      data: { firstName: 'Jane' },
    })

    expect(result.messageId).toBe('msg-123')
    expect(result.channel).toBe('email')
    expect(result.status).toBe('sent')

    const fetchCall = vi.mocked(fetch).mock.calls[0]
    const url = fetchCall[0] as string
    expect(url).toBe('https://janus.test.local/api/relay/send')

    const options = fetchCall[1] as RequestInit
    const body = JSON.parse(options.body as string)
    expect(body.channel).toBe('email')
    expect(body.template).toBe('welcome')
    expect(body.recipient.email).toBe('user@example.com')

    const authHeader = (options.headers as Record<string, string>)['Authorization']
    expect(authHeader).toMatch(/^Bearer /)
  })

  it('uses direct URL when relayUrl is configured', async () => {
    const directClient = new RelayClient({
      relayUrl: 'http://localhost:3001',
      internalKey: 'test-key',
    })

    const mockResponse = {
      success: true,
      data: { messageId: 'msg-1', channel: 'email', status: 'sent', providerMessageId: 'x' },
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockResponse),
    } as Response)

    await directClient.sendEmail({
      template: 'welcome',
      to: { email: 'test@test.com' },
      data: {},
    })

    const fetchCall = vi.mocked(fetch).mock.calls[0]
    const url = fetchCall[0] as string
    expect(url).toBe('http://localhost:3001/send')

    const options = fetchCall[1] as RequestInit
    const headers = options.headers as Record<string, string>
    expect(headers['X-Internal-Key']).toBe('test-key')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('retries on 500 errors', async () => {
    const errorResponse = {
      ok: false,
      status: 500,
      json: () => Promise.resolve({ success: false, error: 'Internal error' }),
    } as Response

    const successResponse = {
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          success: true,
          data: { messageId: 'msg-1', channel: 'email', status: 'sent', providerMessageId: 'x' },
        }),
    } as Response

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorResponse)
      .mockResolvedValueOnce(successResponse)

    const result = await client.sendEmail({
      template: 'welcome',
      to: { email: 'test@test.com' },
      data: {},
    })

    expect(result.messageId).toBe('msg-1')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('throws RelayError on 4xx without retry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
      json: () =>
        Promise.resolve({
          success: false,
          error: 'VALIDATION_ERROR',
          details: { template: 'unknown template' },
        }),
    } as Response)

    await expect(
      client.sendEmail({
        template: 'nonexistent',
        to: { email: 'test@test.com' },
        data: {},
      }),
    ).rejects.toThrow(RelayError)

    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('RelayClient.sendSMS', () => {
  let client: RelayClient

  beforeEach(() => {
    client = new RelayClient({
      jwtSecret: TEST_SECRET,
      programId: 'test-org',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws when recipient has no phone', async () => {
    await expect(
      client.sendSMS({
        template: 'password-reset',
        to: { email: 'test@test.com' },
        data: {},
      }),
    ).rejects.toThrow('E.164 format')
  })

  it('throws for invalid phone format', async () => {
    await expect(
      client.sendSMS({
        template: 'password-reset',
        to: { phone: '5551234567' },
        data: {},
      }),
    ).rejects.toThrow('E.164 format')
  })

  it('sends SMS with correct channel', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          success: true,
          data: { messageId: 'msg-1', channel: 'sms', status: 'sent', providerMessageId: 'tw-1' },
        }),
    } as Response)

    const result = await client.sendSMS({
      template: 'password-reset',
      to: { phone: '+15551234567' },
      data: { resetCode: '123456' },
    })

    expect(result.channel).toBe('sms')

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string)
    expect(body.channel).toBe('sms')
    expect(body.recipient.phone).toBe('+15551234567')
  })
})
