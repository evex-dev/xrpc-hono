just edit lexicon/index.ts  
It says "DO NOT MODIFY," but never mind

before  
```TS
import {
  createServer as createXrpcServer,
  type Server as XrpcServer,
  type Options as XrpcOptions,
  type AuthVerifier,
  type StreamAuthVerifier,
} from '@atproto/xrpc-server'
```

after
```TS
import {
  // createServer as createXrpcServer,
  // type Server as XrpcServer,
  type Options as XrpcOptions,
  type AuthVerifier,
  type StreamAuthVerifier,
} from '@atproto/xrpc-server'
import { createXRPCHono as createXrpcServer,XRPCHono as XrpcServer } from '@evex/xrpc-hono'
```