import { mintServiceJwt, isTokenExpired } from './jwt.js'
import type {
  RelayClientConfig,
  SendRequest,
  SendResponse,
  SendEmailOptions,
  SendSMSOptions,
  MessageStatus,
  ApiResponse,
} from './types.js'

const DEFAULT_JANUS_URL = 'http://janus.janus-prod.svc.cluster.local:3000'
const RELAY_API_PATH = '/api/relay'
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_BIO_ID_URL = 'https://bio.tawa.insureco.io'

export class RelayError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'RelayError'
  }
}

export class RelayClient {
  private readonly config: Required<
    Pick<RelayClientConfig, 'retries' | 'tokenTtlSeconds' | 'sourceService' | 'timeoutMs'>
  > &
    RelayClientConfig

  private cachedToken: string | null = null

  constructor(config: RelayClientConfig) {
    const hasAccessTokenFn = typeof config.accessTokenFn === 'function'
    const hasJwtSecret = !!config.jwtSecret
    const hasRelayUrl = !!config.relayUrl

    if (!hasAccessTokenFn && !hasJwtSecret && !hasRelayUrl) {
      throw new Error(
        'iec-relay: Provide accessTokenFn (recommended), jwtSecret (legacy), or relayUrl (local dev)',
      )
    }

    if (hasJwtSecret && !config.programId) {
      throw new Error('iec-relay: programId is required when using jwtSecret')
    }

    this.config = {
      ...config,
      retries: config.retries ?? 2,
      tokenTtlSeconds: config.tokenTtlSeconds ?? 300,
      sourceService: config.sourceService ?? config.programId ?? 'unknown',
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }
  }

  /**
   * Create a RelayClient from environment variables.
   *
   * Priority:
   * 1. RELAY_DIRECT_URL — local dev (direct to relay, optional RELAY_INTERNAL_KEY)
   * 2. BIO_CLIENT_ID + BIO_CLIENT_SECRET — production gateway (Bio-ID token through Janus)
   * 3. JWT_SECRET + PROGRAM_ID — legacy gateway (self-signed JWT through Janus)
   */
  static fromEnv(): RelayClient {
    // 1. Local dev — direct relay access
    const relayUrl = process.env.RELAY_DIRECT_URL
    if (relayUrl) {
      return new RelayClient({
        relayUrl,
        internalKey: process.env.RELAY_INTERNAL_KEY,
        sourceService: process.env.PROGRAM_ID ?? process.env.SERVICE_NAME,
      })
    }

    // 2. Production — Bio-ID client_credentials through Janus (recommended)
    const bioClientId = process.env.BIO_CLIENT_ID
    const bioClientSecret = process.env.BIO_CLIENT_SECRET
    if (bioClientId && bioClientSecret) {
      const bioIdUrl = process.env.BIO_ID_URL || DEFAULT_BIO_ID_URL
      let cachedBioToken: string | null = null
      let bioTokenExpiresAt = 0

      const accessTokenFn = async (): Promise<string> => {
        const now = Date.now()
        if (cachedBioToken && now < bioTokenExpiresAt) {
          return cachedBioToken
        }

        const response = await fetch(`${bioIdUrl}/api/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'client_credentials',
            client_id: bioClientId,
            client_secret: bioClientSecret,
          }),
        })

        if (!response.ok) {
          const body = await response.text()
          throw new RelayError(
            `Bio-ID token request failed (${response.status}): ${body}`,
            response.status,
            'AUTH_ERROR',
          )
        }

        const data = await response.json() as { access_token: string; expires_in?: number }
        cachedBioToken = data.access_token
        const expiresIn = (data.expires_in || 900) * 1000
        bioTokenExpiresAt = now + expiresIn - 30_000

        return cachedBioToken
      }

      return new RelayClient({
        accessTokenFn,
        janusUrl: process.env.JANUS_URL,
        sourceService: process.env.SERVICE_NAME ?? process.env.PROGRAM_ID,
      })
    }

    // 3. Legacy — self-signed JWT through Janus
    const jwtSecret = process.env.JWT_SECRET
    if (jwtSecret) {
      return new RelayClient({
        jwtSecret,
        programId: process.env.PROGRAM_ID,
        janusUrl: process.env.JANUS_URL,
      })
    }

    throw new Error(
      'iec-relay: No auth configured. Set BIO_CLIENT_ID + BIO_CLIENT_SECRET (recommended), ' +
      'JWT_SECRET + PROGRAM_ID (legacy), or RELAY_DIRECT_URL (local dev)',
    )
  }

  /**
   * Send an email through InsureRelay.
   * Provide either `template` (with `data`) or `content` (raw HTML/text).
   */
  async sendEmail(options: SendEmailOptions): Promise<SendResponse> {
    if (!options.to.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.to.email)) {
      throw new RelayError(
        'Valid recipient email is required for email channel',
        400,
        'VALIDATION_ERROR',
      )
    }

    if (!options.template && !options.content) {
      throw new RelayError(
        'Either template or content is required',
        400,
        'VALIDATION_ERROR',
      )
    }

    if (options.template && options.content) {
      throw new RelayError(
        'Provide template or content, not both',
        400,
        'VALIDATION_ERROR',
      )
    }

    if (options.content) {
      if (!options.content.subject) {
        throw new RelayError(
          'Email content requires a subject',
          400,
          'VALIDATION_ERROR',
        )
      }
      if (!options.content.html && !options.content.text) {
        throw new RelayError(
          'Email content requires either html or text',
          400,
          'VALIDATION_ERROR',
        )
      }
    }

    const sourceAction = options.metadata?.sourceAction ?? options.template ?? 'raw_email'

    return this.send({
      ...(options.template ? { template: options.template } : {}),
      ...(options.content ? { content: options.content } : {}),
      channel: 'email',
      recipient: options.to,
      data: options.data ?? {},
      options: options.options,
      metadata: {
        sourceService: options.metadata?.sourceService ?? this.config.sourceService,
        sourceAction,
        correlationId: options.metadata?.correlationId,
      },
    })
  }

  /**
   * Send an SMS through InsureRelay.
   * Provide either `template` (with `data`) or `content` (raw text).
   */
  async sendSMS(options: SendSMSOptions): Promise<SendResponse> {
    if (!options.to.phone || !/^\+[1-9]\d{1,14}$/.test(options.to.phone)) {
      throw new RelayError(
        'Recipient phone must be in E.164 format (e.g., +15551234567)',
        400,
        'VALIDATION_ERROR',
      )
    }

    if (!options.template && !options.content) {
      throw new RelayError(
        'Either template or content is required',
        400,
        'VALIDATION_ERROR',
      )
    }

    if (options.template && options.content) {
      throw new RelayError(
        'Provide template or content, not both',
        400,
        'VALIDATION_ERROR',
      )
    }

    if (options.content && !options.content.text) {
      throw new RelayError(
        'SMS content requires text',
        400,
        'VALIDATION_ERROR',
      )
    }

    const sourceAction = options.metadata?.sourceAction ?? options.template ?? 'raw_sms'

    return this.send({
      ...(options.template ? { template: options.template } : {}),
      ...(options.content ? { content: options.content } : {}),
      channel: 'sms',
      recipient: options.to,
      data: options.data ?? {},
      options: options.options,
      metadata: {
        sourceService: options.metadata?.sourceService ?? this.config.sourceService,
        sourceAction,
        correlationId: options.metadata?.correlationId,
      },
    })
  }

  /**
   * Get the delivery status of a sent message.
   */
  async getStatus(messageId: string): Promise<MessageStatus> {
    return this.request<MessageStatus>('GET', `/status/${messageId}`)
  }

  /**
   * List available templates on the relay service.
   */
  async listTemplates(): Promise<string[]> {
    const response = await this.request<{ templates: string[] }>('GET', '/templates')
    return response.templates
  }

  /**
   * Low-level send — use sendEmail() or sendSMS() instead.
   */
  async send(body: SendRequest): Promise<SendResponse> {
    return this.request<SendResponse>('POST', '/send', body)
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    attempt: number = 0,
  ): Promise<T> {
    const { url, headers } = await this.buildRequest(path)

    const fetchOptions: RequestInit = {
      method,
      headers: {
        ...headers,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    }

    let response: Response

    try {
      response = await fetch(url, fetchOptions)
    } catch (err) {
      if (attempt < this.config.retries) {
        const baseDelay = Math.min(1000 * 2 ** attempt, 5000)
        const delay = baseDelay * (0.5 + Math.random() * 0.5)
        await sleep(delay)
        return this.request<T>(method, path, body, attempt + 1)
      }

      const isTimeout =
        err instanceof DOMException && err.name === 'TimeoutError'
      const message = isTimeout
        ? `Request timed out after ${this.config.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : 'Network error'

      throw new RelayError(
        `Failed to reach InsureRelay: ${message}`,
        0,
        isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      )
    }

    let json: ApiResponse<T>
    try {
      json = (await response.json()) as ApiResponse<T>
    } catch {
      if (response.status >= 500 && attempt < this.config.retries) {
        const baseDelay = Math.min(1000 * 2 ** attempt, 5000)
        const delay = baseDelay * (0.5 + Math.random() * 0.5)
        await sleep(delay)
        return this.request<T>(method, path, body, attempt + 1)
      }

      throw new RelayError(
        `InsureRelay returned ${response.status} with non-JSON body`,
        response.status,
        'PARSE_ERROR',
      )
    }

    if (!response.ok) {
      if (response.status >= 500 && attempt < this.config.retries) {
        const baseDelay = Math.min(1000 * 2 ** attempt, 5000)
        const delay = baseDelay * (0.5 + Math.random() * 0.5)
        await sleep(delay)
        return this.request<T>(method, path, body, attempt + 1)
      }

      throw new RelayError(
        json.error ?? `InsureRelay returned ${response.status}`,
        response.status,
        json.error,
        json.details,
      )
    }

    if (!json.data) {
      throw new RelayError('InsureRelay returned success but no data', 500, 'EMPTY_RESPONSE')
    }

    return json.data
  }

  private async buildRequest(path: string): Promise<{ url: string; headers: Record<string, string> }> {
    const headers: Record<string, string> = {}

    // Direct mode (local dev) — call relay URL directly
    if (this.config.relayUrl) {
      const url = `${this.config.relayUrl}${path}`
      if (this.config.accessTokenFn) {
        headers['Authorization'] = `Bearer ${await this.config.accessTokenFn()}`
      } else if (this.config.internalKey) {
        headers['X-Internal-Key'] = this.config.internalKey
      }
      return { url, headers }
    }

    // Gateway mode — route through Janus
    const baseUrl = this.config.janusUrl ?? DEFAULT_JANUS_URL
    const url = `${baseUrl}${RELAY_API_PATH}${path}`

    // Bio-ID token auth (recommended)
    if (this.config.accessTokenFn) {
      headers['Authorization'] = `Bearer ${await this.config.accessTokenFn()}`
      return { url, headers }
    }

    // Legacy self-signed JWT auth
    headers['Authorization'] = `Bearer ${this.getToken()}`
    return { url, headers }
  }

  private getToken(): string {
    if (this.cachedToken && !isTokenExpired(this.cachedToken)) {
      return this.cachedToken
    }

    if (!this.config.jwtSecret || !this.config.programId) {
      throw new RelayError(
        'jwtSecret and programId are required for legacy Janus auth',
        500,
        'CONFIG_ERROR',
      )
    }

    this.cachedToken = mintServiceJwt(
      this.config.jwtSecret,
      this.config.programId,
      this.config.tokenTtlSeconds,
    )

    return this.cachedToken
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
