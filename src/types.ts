import type { Context, Env } from 'hono'
import type {
  AuthOutput,
  HandlerAuth,
  HandlerInput,
  HandlerOutput,
  Params,
} from '@atproto/xrpc-server'

export interface HonoAuthVerifierContext {
  ctx: Context
}

export type HonoAuthVerifier = (
  ctx: HonoAuthVerifierContext,
) => Promise<AuthOutput> | AuthOutput

export type HonoXRPCHandlerConfig<E extends Env> = {
  auth?: HonoAuthVerifier
  handler: HonoXRPCHandler<E>
}

export type HonoXRPCHandler<E extends Env> = (
  ctx: HonoXRPCReqContext<E>,
) => Promise<HandlerOutput> | HandlerOutput | undefined

export type HonoXRPCReqContext<E extends Env> = {
  auth: HandlerAuth | undefined
  params: Params
  input: HandlerInput | undefined
  c: Context<E>
}