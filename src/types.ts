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

export type HonoAuthVerifier<E extends Env, A extends AuthResult> = (
  ctx: HonoAuthVerifierContext<E>,
) => Awaitable<A | ErrorResult>

export type HonoXRPCHandlerConfig<E extends Env, A extends AuthResult> = {
  auth?: HonoAuthVerifier<E, A>
  handler: HonoXRPCHandler<E, A>
}

export type HonoXRPCHandler<E extends Env, A extends AuthResult> = (
  ctx: HonoXRPCReqContext<E, A>,
) => Promise<Output> | Output | undefined

export type HonoXRPCReqContext<E extends Env, A extends AuthResult> = {
  auth: A | undefined
  params: Params
  input: HandlerInput | undefined
  c: Context<E>
}
export type RequestLocals = {
  auth: AuthResult | undefined
  nsid: string
}
