/** Built-in template names available in InsureRelay */
export type BuiltInTemplate = 'welcome' | 'invitation' | 'password-reset' | 'magic-link'

/** Recipient for an email or SMS message */
export interface Recipient {
  /** Email address (required for email channel) */
  email?: string
  /** Phone number in E.164 format, e.g. +15551234567 (required for SMS channel) */
  phone?: string
  /** Recipient display name */
  name?: string
}

/** Options for sending a message */
export interface SendOptions {
  /** Override default sender address */
  from?: string
  /** Reply-to address */
  replyTo?: string
  /** Message priority */
  priority?: 'high' | 'normal' | 'low'
}

/** Metadata attached to a message for tracking */
export interface MessageMetadata {
  /** Name of the calling service, e.g. 'bio-id' */
  sourceService: string
  /** Action that triggered the send, e.g. 'user_registered' */
  sourceAction: string
  /** Correlation ID for tracing across services */
  correlationId?: string
}

/** Raw content payload for template-less sends */
export interface ContentPayload {
  /** Email subject (required for email channel) */
  subject?: string
  /** Raw HTML body (email only) */
  html?: string
  /** Plain text body (required for SMS, optional fallback for email) */
  text?: string
}

/** Full request body for POST /api/relay/send */
export interface SendRequest {
  template?: string
  channel: 'email' | 'sms'
  content?: ContentPayload
  recipient: Recipient
  data: Record<string, unknown>
  options?: SendOptions
  metadata?: MessageMetadata
}

/** Successful send response */
export interface SendResponse {
  messageId: string
  channel: 'email' | 'sms'
  status: 'sent'
  providerMessageId: string
}

/** Message status from GET /api/relay/status/:id */
export interface MessageStatus {
  messageId: string
  channel: 'email' | 'sms'
  template: string
  status: 'sent' | 'delivered' | 'failed'
  recipient: Recipient
  sender: string
  sentAt: string
  providerMessageId: string
}

/** API response wrapper */
export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  details?: Record<string, unknown>
}

/** Configuration for the RelayClient */
export interface RelayClientConfig {
  /**
   * Async function returning a Bearer token (e.g. Bio-ID client_credentials).
   * This is the recommended auth method — works with both gateway (Janus) and direct modes.
   * In gateway mode, the builder auto-provisions BIO_CLIENT_ID + BIO_CLIENT_SECRET.
   */
  accessTokenFn?: () => Promise<string>
  /** Janus gateway URL (default: http://janus.janus-prod.svc.cluster.local:3000) */
  janusUrl?: string
  /** Direct relay URL for local dev (bypasses Janus) */
  relayUrl?: string
  /** Internal API key for direct relay access (local dev only) */
  internalKey?: string
  /**
   * @deprecated Use accessTokenFn with Bio-ID client_credentials instead.
   * Shared JWT secret for minting service tokens.
   */
  jwtSecret?: string
  /**
   * @deprecated Use accessTokenFn with Bio-ID client_credentials instead.
   * Program/org ID included in the JWT.
   */
  programId?: string
  /** JWT token lifetime in seconds (default: 300). Only used with legacy jwtSecret auth. */
  tokenTtlSeconds?: number
  /**
   * Number of retry attempts on transient failures (default: 2).
   * Note: Retries on POST /send may cause duplicate messages if the server
   * processed the request but the response was lost. Set to 0 if duplicates
   * are unacceptable.
   */
  retries?: number
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number
  /** Source service name for metadata (default: programId or 'unknown') */
  sourceService?: string
}

/** Base options shared by sendEmail and sendSMS */
interface BaseSendOptions {
  /** Template name (built-in or custom). Required unless content is provided. */
  template?: BuiltInTemplate | (string & {})
  /** Raw content for template-less sends. Required unless template is provided. */
  content?: ContentPayload
  /** Recipient */
  to: Recipient
  /** Template variables (used with template mode) */
  data?: Record<string, unknown>
  /** Optional send options */
  options?: SendOptions
  /** Optional metadata overrides */
  metadata?: Partial<MessageMetadata>
}

/** Options for sendEmail — requires to.email */
export interface SendEmailOptions extends BaseSendOptions {}

/** Options for sendSMS — requires to.phone */
export interface SendSMSOptions extends BaseSendOptions {}
