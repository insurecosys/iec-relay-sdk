/** Built-in template names available in InsureRelay */
export type BuiltInTemplate = 'welcome' | 'invitation' | 'password-reset'

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

/** Full request body for POST /api/relay/send */
export interface SendRequest {
  template: string
  channel: 'email' | 'sms'
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
  /** Shared JWT secret for minting service tokens (required when using Janus) */
  jwtSecret?: string
  /** Program/org ID included in the JWT (default: derived from service name) */
  programId?: string
  /** Janus gateway URL (default: http://janus.janus-prod.svc.cluster.local:3000) */
  janusUrl?: string
  /** Direct relay URL for local dev (bypasses Janus, uses X-Internal-Key auth) */
  relayUrl?: string
  /** Internal API key for direct relay access */
  internalKey?: string
  /** JWT token lifetime in seconds (default: 300 = 5 minutes) */
  tokenTtlSeconds?: number
  /** Number of retry attempts on transient failures (default: 2) */
  retries?: number
  /** Source service name for metadata (default: programId) */
  sourceService?: string
}

/** Simplified options for sendEmail */
export interface SendEmailOptions {
  /** Template name */
  template: string
  /** Recipient */
  to: Recipient
  /** Template variables */
  data: Record<string, unknown>
  /** Optional send options */
  options?: SendOptions
  /** Optional metadata overrides */
  metadata?: Partial<MessageMetadata>
}

/** Simplified options for sendSMS */
export interface SendSMSOptions {
  /** Template name */
  template: string
  /** Recipient */
  to: Recipient
  /** Template variables */
  data: Record<string, unknown>
  /** Optional send options */
  options?: SendOptions
  /** Optional metadata overrides */
  metadata?: Partial<MessageMetadata>
}
