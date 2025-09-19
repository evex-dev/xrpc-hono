import type { Context, Env } from 'hono'
import {
  AuthResult,
  HandlerInput,
  Output,
  Params,
} from './xrpc-server-types.ts'

export interface HonoAuthVerifierContext {
  ctx: Context
}

export type HonoAuthVerifier = (
  ctx: HonoAuthVerifierContext,
) => Promise<AuthResult> | AuthResult

export type HonoXRPCHandlerConfig<E extends Env> = {
  auth?: HonoAuthVerifier
  handler: HonoXRPCHandler<E>
}

export type HonoXRPCHandler<E extends Env> = (
  ctx: HonoXRPCReqContext<E>,
) => Promise<Output> | Output | undefined

export type HonoXRPCReqContext<E extends Env> = {
  auth: AuthResult | undefined
  params: Params
  input: HandlerInput | undefined
  c: Context<E>
}
