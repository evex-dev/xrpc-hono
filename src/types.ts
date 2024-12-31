export interface HandlerAuth {
  credentials: unknown
  artifacts: unknown
}
export type Primitive = string | number | boolean
export type HandlerParams = Record<string, Primitive | Primitive[] | undefined>
export interface HandlerInput {
  encoding: string
  body: unknown
}

export interface HandlerSuccess {
  encoding: string
  body: unknown
  headers?: Record<string, string>
}
export interface HandlerPipeThroughBuffer {
  encoding: string
  body: Uint8Array
  headers?: Record<string, string>
}
export interface HandlerPipeThroughStream {
  encoding: string
  body: ReadableStream<Uint8Array>
  headers?: Record<string, string>
}
export interface HandlerError {
  status: number
  error?: string
  message?: string
}
export type HandlerPipeThrough = HandlerPipeThroughBuffer | HandlerPipeThroughStream
export type HandlerOutput = HandlerSuccess | HandlerPipeThrough | HandlerError
