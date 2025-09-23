import type { Context, Env } from 'hono'
import type {
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

export type HonoXRPCHandlerConfig<
  E extends Env,
  A extends AuthResult,
  P extends Params,
  I extends HandlerInput | undefined,
  O extends Output,
> = {
  auth?: HonoAuthVerifier<E, A>
  handler: HonoXRPCHandler<E, A, P, I, O>
}

export type HonoXRPCHandler<
  E extends Env,
  A extends AuthResult,
  P extends Params,
  I extends HandlerInput | undefined,
  O extends Output,
> = (
  ctx: HonoXRPCReqContext<E, A, P, I>,
) => Awaitable<O>

export type HonoXRPCReqContext<
  E extends Env,
  A extends AuthResult,
  P extends Params,
  I extends HandlerInput | undefined,
> = {
  auth: A
  params: P
  input: I
  c: Context<E>
}
export type RequestLocals = {
  auth: AuthResult | undefined
  nsid: string
}
