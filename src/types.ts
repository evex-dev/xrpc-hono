import type { Context } from 'hono'
import type {
  AuthOutput,
  XRPCHandler,
} from '@atproto/xrpc-server'

export interface HonoAuthVerifierContext {
  ctx: Context
}

export type HonoAuthVerifier = (
  ctx: HonoAuthVerifierContext,
) => Promise<AuthOutput> | AuthOutput

export type HonoXRPCHandlerConfig = {
  auth?: HonoAuthVerifier
  handler: XRPCHandler
}
