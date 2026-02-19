import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RelayClient, RelayError } from './client.js'

const TEST_SECRET = '370e0b7a6c0f59b8979701ad239fda3cfafb1ce0215e70497b8ddea2f7ba44ee'

describe('RelayClient constructor', () => {
  it('requires accessTokenFn, jwtSecret, or relayUrl', () => {
    expect(() => new RelayClient({})).toThrow('Provide accessTokenFn')
  })

  it('requires programId when using jwtSecret', () => {
    expect(() => new RelayClient({ jwtSecret: TEST_SECRET })).toThrow('programId is required')
  })

  it('accepts accessTokenFn for Bio-ID gateway mode', () => {
    const client = new RelayClient({ accessTokenFn: async () => 'token' })
    expect(client).toBeInstanceOf(RelayClient)
  })

  it('accepts jwtSecret + programId (legacy)', () => {
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
    delete process.env.RELAY_DIRECT_URL
    delete process.env.RELAY_INTERNAL_KEY
    delete process.env.BIO_CLIENT_ID
    delete process.env.BIO_CLIENT_SECRET
    delete process.env.BIO_ID_URL
    delete process.env.JWT_SECRET
    delete process.env.PROGRAM_ID
    delete process.env.JANUS_URL
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('creates client from RELAY_DIRECT_URL (local dev)', () => {
    process.env.RELAY_DIRECT_URL = 'http://localhost:3001'
    const client = RelayClient.fromEnv()
    expect(client).toBeInstanceOf(RelayClient)
  })

  it('creates client from BIO_CLIENT_ID + BIO_CLIENT_SECRET (recommended)', () => {
    process.env.BIO_CLIENT_ID = 'my-service-prod'
    process.env.BIO_CLIENT_SECRET = 'secret_abc123'
    const client = RelayClient.fromEnv()
    expect(client).toBeInstanceOf(RelayClient)
  })

  it('creates client from JWT_SECRET + PROGRAM_ID (legacy)', () => {
    process.env.JWT_SECRET = TEST_SECRET
    process.env.PROGRAM_ID = 'test-org'
    const client = RelayClient.fromEnv()
    expect(client).toBeInstanceOf(RelayClient)
  })

  it('prefers RELAY_DIRECT_URL over BIO_CLIENT_ID', async () => {
    process.env.RELAY_DIRECT_URL = 'http://localhost:3001'
    process.env.BIO_CLIENT_ID = 'my-service-prod'
    process.env.BIO_CLIENT_SECRET = 'secret_abc123'

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        success: true,
        data: { messageId: 'msg-1', channel: 'email', status: 'sent', providerMessageId: 'x' },
      }),
    } as Response)

    const client = RelayClient.fromEnv()
    await client.sendEmail({
      content: { subject: 'Test', html: '<p>Hi</p>' },
      to: { email: 'test@test.com' },
    })

    const url = vi.mocked(fetch).mock.calls[0]?.[0] as string
    expect(url).toBe('http://localhost:3001/send')

    vi.restoreAllMocks()
  })

  it('prefers BIO_CLIENT_ID over JWT_SECRET', () => {
    process.env.BIO_CLIENT_ID = 'my-service-prod'
    process.env.BIO_CLIENT_SECRET = 'secret_abc123'
    process.env.JWT_SECRET = TEST_SECRET
    process.env.PROGRAM_ID = 'test-org'

    // Bio-ID token fetch will be called when sending — just verify client creates
    const client = RelayClient.fromEnv()
    expect(client).toBeInstanceOf(RelayClient)
  })

  it('throws when no env vars are set', () => {
    expect(() => RelayClient.fromEnv()).toThrow('No auth configured')
  })
})

describe('RelayClient Bio-ID gateway mode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('routes through Janus with Bio-ID token', async () => {
    const mockTokenFn = vi.fn().mockResolvedValue('bio-token-abc')

    const client = new RelayClient({
      accessTokenFn: mockTokenFn,
      janusUrl: 'https://janus.test.local',
      sourceService: 'ppay-board',
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        success: true,
        data: { messageId: 'msg-1', channel: 'email', status: 'sent', providerMessageId: 'sg-1' },
      }),
    } as Response)

    await client.sendEmail({
      content: { subject: 'Test', html: '<p>Hi</p>' },
      to: { email: 'user@example.com' },
    })

    const fetchCall = vi.mocked(fetch).mock.calls[0]
    const url = fetchCall[0] as string
    expect(url).toBe('https://janus.test.local/api/relay/send')

    const options = fetchCall[1] as RequestInit
    const headers = options.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer bio-token-abc')
    expect(mockTokenFn).toHaveBeenCalledOnce()
  })

  it('uses default Janus URL when janusUrl is not set', async () => {
    const client = new RelayClient({
      accessTokenFn: async () => 'token',
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        success: true,
        data: { messageId: 'msg-1', channel: 'email', status: 'sent', providerMessageId: 'x' },
      }),
    } as Response)

    await client.sendEmail({
      content: { subject: 'Test', html: '<p>Hi</p>' },
      to: { email: 'test@test.com' },
    })

    const url = vi.mocked(fetch).mock.calls[0][0] as string
    expect(url).toBe('http://janus.janus-prod.svc.cluster.local:3000/api/relay/send')
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

  it('throws when neither template nor content is provided', async () => {
    await expect(
      client.sendEmail({
        to: { email: 'test@test.com' },
      }),
    ).rejects.toThrow('Either template or content')
  })

  it('throws when both template and content are provided', async () => {
    await expect(
      client.sendEmail({
        template: 'welcome',
        content: { subject: 'Hi', html: '<p>Hello</p>' },
        to: { email: 'test@test.com' },
      }),
    ).rejects.toThrow('not both')
  })

  it('throws when email content has no subject', async () => {
    await expect(
      client.sendEmail({
        content: { html: '<p>Hello</p>' },
        to: { email: 'test@test.com' },
      }),
    ).rejects.toThrow('requires a subject')
  })

  it('throws when email content has no html or text', async () => {
    await expect(
      client.sendEmail({
        content: { subject: 'Hi' },
        to: { email: 'test@test.com' },
      }),
    ).rejects.toThrow('either html or text')
  })

  it('sends raw HTML email with content field', async () => {
    const mockResponse = {
      success: true,
      data: {
        messageId: 'msg-raw-1',
        channel: 'email',
        status: 'sent',
        providerMessageId: 'sg-raw-1',
      },
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockResponse),
    } as Response)

    const result = await client.sendEmail({
      content: { subject: 'Invoice', html: '<h1>Invoice #1</h1>' },
      to: { email: 'user@example.com' },
    })

    expect(result.messageId).toBe('msg-raw-1')

    const fetchCall = vi.mocked(fetch).mock.calls[0]
    const body = JSON.parse((fetchCall[1] as RequestInit).body as string)
    expect(body.content).toEqual({ subject: 'Invoice', html: '<h1>Invoice #1</h1>' })
    expect(body.template).toBeUndefined()
    expect(body.channel).toBe('email')
    expect(body.metadata.sourceAction).toBe('raw_email')
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

  it('throws when neither template nor content is provided', async () => {
    await expect(
      client.sendSMS({
        to: { phone: '+15551234567' },
      }),
    ).rejects.toThrow('Either template or content')
  })

  it('throws when both template and content are provided', async () => {
    await expect(
      client.sendSMS({
        template: 'password-reset',
        content: { text: 'Your code is 123456' },
        to: { phone: '+15551234567' },
      }),
    ).rejects.toThrow('not both')
  })

  it('throws when SMS content has no text', async () => {
    await expect(
      client.sendSMS({
        content: { subject: 'Code' },
        to: { phone: '+15551234567' },
      }),
    ).rejects.toThrow('SMS content requires text')
  })

  it('sends raw SMS with content field', async () => {
    const mockResponse = {
      success: true,
      data: {
        messageId: 'msg-raw-sms',
        channel: 'sms',
        status: 'sent',
        providerMessageId: 'tw-raw-1',
      },
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockResponse),
    } as Response)

    const result = await client.sendSMS({
      content: { text: 'Your verification code is 123456' },
      to: { phone: '+15551234567' },
    })

    expect(result.messageId).toBe('msg-raw-sms')

    const fetchCall = vi.mocked(fetch).mock.calls[0]
    const body = JSON.parse((fetchCall[1] as RequestInit).body as string)
    expect(body.content).toEqual({ text: 'Your verification code is 123456' })
    expect(body.template).toBeUndefined()
    expect(body.channel).toBe('sms')
    expect(body.metadata.sourceAction).toBe('raw_sms')
  })
})
