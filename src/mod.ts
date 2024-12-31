import { Context, type MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { StatusCode } from 'hono/utils/http-status'
import { Lexicons, type LexiconDoc } from '@atproto/lexicon'
import { HandlerAuth, HandlerInput, HandlerOutput } from "./types.ts";
import { Params } from "hono/router";

export interface XRPCHandler {
  (
    auth: HandlerAuth | undefined,
    params: Params,
    input: HandlerInput | undefined,
    c: Context
  ): HandlerOutput | Promise<HandlerOutput>
}
export interface XRPCHono {
  addMethod (method: string, handler: XRPCHandler): void
  createApp (): Hono
}
export const createXRPCHono = (lexiconsSource: LexiconDoc[]): XRPCHono => {
  const methods = new Map<string, XRPCHandler>()

  const lexicons = new Lexicons(lexiconsSource)

  return {
    addMethod (method: string, handler: XRPCHandler) {
      methods.set(method, handler)
    },
    createApp () {
      const app = new Hono()

      for (const lexicon of lexiconsSource) {
        const handler = methods.get(lexicon.id)
        if (!handler) {
          throw new Error(`No handler for ${lexicon.id}`)
        }
        const def = lexicons.getDefOrThrow(lexicon.id)
        const method = def.type === 'procedure' ? 'POST' : 'GET'
        app[method === 'GET' ? 'get' : 'post'](`/xrpc/${lexicon.id}`, async (c) => {
          const encoding = c.req.header('Content-Type')
          let input: HandlerInput | undefined = undefined
          if (encoding) {
            let body: unknown = undefined
            if (encoding.startsWith('application/json')) {
              body = await c.req.json()
            } else if (encoding.startsWith('application/x-www-form-urlencoded')) {
              body = await c.req.formData()
            } else if (encoding.startsWith('text/')) {
              body = await c.req.text()
            } else {
              throw new Error(`Unsupported encoding: ${encoding}`)
            }
            input = { encoding, body }
            lexicons.assertValidXrpcInput(lexicon.id, input)
          }
          const params = c.req.query()
          lexicons.assertValidXrpcParams(lexicon.id, params)
          const output = await handler(
            undefined, // I don't know what to put here
            params,
            input,
            c
          )
          if ('status' in output) {
            // HandlerError
            c.status(output.status as StatusCode)
          } else {
            c.header('Content-Type', output.encoding)
            if (output.body instanceof Uint8Array) {
              return c.body(output.body)
            } else if (output.body instanceof ReadableStream) {
              return c.body(output.body)
            } else if (output.encoding.startsWith('application/json')) {
              return c.json(output.body as any)
            } else if (output.encoding.startsWith('application/x-www-form-urlencoded')) {
              const formData = new FormData()
              for (const [key, value] of Object.entries(output.body as Record<string, string>)) {
                formData.append(key, value)
              }
              // @ts-ignore FormData is not supported.
              return c.body(formData)
            } else if (output.encoding.startsWith('text/')) {
              return c.text(output.body as string)
            }
          }
        })
      }

      return app
    }
  }
}
