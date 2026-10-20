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

The relative imports in the generated files use the `.js` extension by default, which works with `tsc` (`moduleResolution` `node16`/`nodenext`/`bundler`) and with bundlers. Use `--import-ext` to change it:

| `--import-ext` | For |
|---|---|
| `.js` (default) | `tsc`, Bun, Vite, esbuild and other bundlers |
| `.ts` | Deno, Bun, running `.ts` files directly on Node.js (type stripping), or `tsc` with `allowImportingTsExtensions` / `rewriteRelativeImportExtensions` |
| `""` | bundlers only (extension-less imports) |

```sh
gen-xrpc-hono --import-ext .ts ./src/lexicons/ ./lexicons/io/example/*.json
```

## Usage

### With generated server bindings

```ts
import { createServer } from './src/lexicons'
import { Hono } from 'hono'

type Env = { Bindings: {}; Variables: {} }

const server = createServer<Env>()

server.io.example.ping(async ({ auth, params, input, c }) => {
  return {
    encoding: 'application/json',
    body: { pong: true },
  }
})

const app = new Hono<Env>()
app.route('/', server.xrpc.createApp())
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

### Subscriptions (Event Streams)

Subscriptions are served over WebSockets ([Event Stream spec](https://atproto.com/specs/event-stream)): each message is sent as a binary frame of two DRISL-CBOR objects (header and payload). Pass the WebSocket helper of your runtime as the `upgradeWebSocket` option; without it, subscriptions answer `501`.

The handler is an async generator yielding `$type`-tagged messages of the subscription's message union. Throwing an `XRPCError` (or yielding an `ErrorFrame`) sends an error frame and closes the stream. Errors before the first message (invalid params, auth) are sent the same way, as the first frame. `signal` is aborted when the client disconnects.

```ts
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { createServer } from './src/lexicons'
import { InvalidRequestError } from '@evex-dev/xrpc-hono'

const app = new Hono()
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app })

const server = createServer({ upgradeWebSocket })

server.com.atproto.sync.subscribeRepos(async function* ({ params, signal }) {
  if (params.cursor !== undefined && params.cursor > latestSeq()) {
    throw new InvalidRequestError('Cursor in the future.', 'FutureCursor')
  }
  for await (const evt of events(params.cursor, signal)) {
    yield { $type: 'com.atproto.sync.subscribeRepos#identity', ...evt }
  }
})

app.route('/', server.xrpc.createApp())
injectWebSocket(serve({ fetch: app.fetch, port: 3000 }))
```

Without generated bindings, use `xrpc.addStreamMethod(nsid, handler)` (or `{ auth, handler }`).

Notes:
- The `upgradeWebSocket` helper must call `onOpen` (`@hono/node-ws`, `hono/bun` and `hono/deno` do; `hono/cloudflare-workers` does not, so Cloudflare Workers are not supported yet).
- Outgoing messages are validated against the Lexicon; an invalid message ends the stream with an `InternalServerError` error frame.
- Sending does not wait for the socket to drain, so a handler should not produce messages much faster than clients can read them.

## License

MIT — see the repository root LICENCE file for details.