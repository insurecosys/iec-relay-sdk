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
    if (!config.jwtSecret && !config.relayUrl) {
      throw new Error(
        'iec-relay: Either jwtSecret (for Janus) or relayUrl + internalKey (for direct) is required',
      )
    }

    if (config.jwtSecret && !config.programId) {
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
   * Reads: JANUS_URL, JWT_SECRET, PROGRAM_ID, RELAY_DIRECT_URL, RELAY_INTERNAL_KEY
   */
  static fromEnv(): RelayClient {
    const relayUrl = process.env.RELAY_DIRECT_URL
    const internalKey = process.env.RELAY_INTERNAL_KEY

    if (relayUrl) {
      return new RelayClient({
        relayUrl,
        internalKey,
        sourceService: process.env.PROGRAM_ID ?? process.env.SERVICE_NAME,
      })
    }

    const jwtSecret = process.env.JWT_SECRET
    if (!jwtSecret) {
      throw new Error(
        'iec-relay: Set JWT_SECRET + PROGRAM_ID (for Janus) or RELAY_DIRECT_URL (for direct)',
      )
    }

    return new RelayClient({
      jwtSecret,
      programId: process.env.PROGRAM_ID,
      janusUrl: process.env.JANUS_URL,
    })
  }

  /**
   * Send an email through InsureRelay.
   */
  async sendEmail(options: SendEmailOptions): Promise<SendResponse> {
    if (!options.to.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.to.email)) {
      throw new RelayError(
        'Valid recipient email is required for email channel',
        400,
        'VALIDATION_ERROR',
      )
    }

    return this.send({
      template: options.template,
      channel: 'email',
      recipient: options.to,
      data: options.data,
      options: options.options,
      metadata: {
        sourceService: options.metadata?.sourceService ?? this.config.sourceService,
        sourceAction: options.metadata?.sourceAction ?? options.template,
        correlationId: options.metadata?.correlationId,
      },
    })
  }

  /**
   * Send an SMS through InsureRelay.
   */
  async sendSMS(options: SendSMSOptions): Promise<SendResponse> {
    if (!options.to.phone || !/^\+[1-9]\d{1,14}$/.test(options.to.phone)) {
      throw new RelayError(
        'Recipient phone must be in E.164 format (e.g., +15551234567)',
        400,
        'VALIDATION_ERROR',
      )
    }

    return this.send({
      template: options.template,
      channel: 'sms',
      recipient: options.to,
      data: options.data,
      options: options.options,
      metadata: {
        sourceService: options.metadata?.sourceService ?? this.config.sourceService,
        sourceAction: options.metadata?.sourceAction ?? options.template,
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
    const { url, headers } = this.buildRequest(path)

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

  private buildRequest(path: string): { url: string; headers: Record<string, string> } {
    const headers: Record<string, string> = {}

    if (this.config.relayUrl) {
      const url = `${this.config.relayUrl}${path}`
      if (this.config.internalKey) {
        headers['X-Internal-Key'] = this.config.internalKey
      }
      return { url, headers }
    }

    const baseUrl = this.config.janusUrl ?? DEFAULT_JANUS_URL
    const url = `${baseUrl}${RELAY_API_PATH}${path}`
    headers['Authorization'] = `Bearer ${this.getToken()}`

    return { url, headers }
  }

  private getToken(): string {
    if (this.cachedToken && !isTokenExpired(this.cachedToken)) {
      return this.cachedToken
    }

    if (!this.config.jwtSecret || !this.config.programId) {
      throw new RelayError(
        'jwtSecret and programId are required for Janus auth',
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
