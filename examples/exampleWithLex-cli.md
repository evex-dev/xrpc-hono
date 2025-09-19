edit lexicon/index.ts\
It says "DO NOT MODIFY," but never mind

before

```TS
import {
  type AuthVerifier,
  createServer as createXrpcServer,
  type Options as XrpcOptions,
  type Server as XrpcServer,
  type StreamAuthVerifier,
} from '@atproto/xrpc-server'
```

after

```TS
import {
  type AuthVerifier,
  // createServer as createXrpcServer,
  // type Server as XrpcServer,
  type Options as XrpcOptions,
  type StreamAuthVerifier,
} from '@atproto/xrpc-server'
import {
  createXRPCHono as createXrpcServer,
  XRPCHono as XrpcServer,
} from '@evex/xrpc-hono'
```
