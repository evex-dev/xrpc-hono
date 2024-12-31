import type { LexiconDoc } from '@atproto/lexicon'
import { Hono } from "hono";
import { createXRPCHono } from "../src/mod.ts";

const lexicons: LexiconDoc[] = [
  {
    lexicon: 1,
    id: 'io.example.ping',
    defs: {
      main: {
        type: 'query',
        parameters: {
          type: 'params',
          properties: { message: { type: 'string' } },
        },
        output: {
          encoding: 'application/json',
        },
      }
    },
  },
]

const app = new Hono()

const xrpc = createXRPCHono(lexicons)
xrpc.addMethod('io.example.ping', async (auth, params, input, c) => {
  return {
    encoding: 'application/json',
    body: { pong: true }
  }
})
app.route('/', xrpc.createApp())

export default app
