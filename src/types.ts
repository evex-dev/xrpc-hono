import type { Context, Env } from 'hono'
import {
  AuthResult,
  Awaitable,
  HandlerInput,
  Output,
  Params,
} from './xrpc-server-types.ts'

type ErrorResult = {
  status: number
  message?: string
  error?: string
}

export type HonoAuthVerifierContext<E extends Env> = {
  ctx: Context<E>
}

export type HonoAuthVerifier<E extends Env> = (
  ctx: HonoAuthVerifierContext<E>,
) => Awaitable<AuthResult | ErrorResult>

export type HonoXRPCHandlerConfig<E extends Env> = {
  auth?: HonoAuthVerifier<E>
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
export type RequestLocals = {
  auth: AuthResult | undefined
  nsid: string
}
