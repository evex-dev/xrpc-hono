# xrpc-hono

TypeScript library for implementing atproto HTTP API services with Hono and Lexicon schema validation.

[![NPM](https://img.shields.io/npm/v/@evex-dev/xrpc-hono)](https://www.npmjs.com/package/@evex-dev/xrpc-hono)

## Installation

Install from npm:

```sh
npm install @evex-dev/xrpc-hono
# or
pnpm add @evex-dev/xrpc-hono
```

## CLI

A small CLI is included for generating server bindings from Lexicon files.

```sh
# generate server files from lexicon JSON
gen-xrpc-hono ./src/lexicons/ ./lexicons/io/example/*.json
```

## Usage

### With generated server bindings

```ts
import { createServer } from './src/lexicons'
import { Hono } from 'hono'

type Env = { Bindings: {}; Variables: {} }

const xrpc = createServer<Env>()

xrpc.io.example.ping(async ({ auth, params, input, c }) => {
  return {
    encoding: 'application/json',
    body: { pong: true },
  }
})

const app = new Hono<Env>()
app.route('/', xrpc.createApp())
export default app
```

### Without generation (runtime registration)

```ts
import type { LexiconDoc } from '@atproto/lexicon'
import { Hono } from 'hono'
import { createXRPCHono } from '@evex-dev/xrpc-hono'

const lexicons: LexiconDoc[] = [
  {
    lexicon: 1,
    id: 'io.example.ping',
    defs: {
      main: {
        type: 'query',
        parameters: { type: 'params', properties: { message: { type: 'string' } } },
        output: { encoding: 'application/json' },
      },
    },
  },
]

type Env = { Bindings: {}; Variables: {} }

const app = new Hono<Env>()
const xrpc = createXRPCHono<Env>(lexicons)

xrpc.addMethod('io.example.ping', async ({ auth, params, input, c }) => ({
  encoding: 'application/json',
  body: { pong: true },
}))

// With auth handler
xrpc.addMethod('io.example.ping', {
  auth: async ({ ctx }) => ({ credentials: {}, artifacts: {} }),
  handler: async ({ auth, params, input, c }) => ({
    encoding: 'application/json',
    body: { pong: true },
  }),
})

app.route('/', xrpc.createApp())
export default app
```

## License

MIT — see the repository root LICENCE file for details.