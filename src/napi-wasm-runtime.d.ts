declare module '@napi-rs/wasm-runtime' {
  interface WorkerLoadContext {
    wasmModule: WebAssembly.Module
    wasmMemory: WebAssembly.Memory
  }

  interface RuntimeImportObject {
    env: Record<string, unknown>
    napi?: Record<string, unknown>
    emnapi?: Record<string, unknown>
    [namespace: string]: Record<string, unknown> | undefined
  }

  interface NapiModuleOptions {
    childThread?: boolean
    wasi?: WASI
    overwriteImports?: (importObject: RuntimeImportObject) => void
  }

  export class WASI {
    constructor(options?: {
      version?: string
      print?: (...args: unknown[]) => void
      printErr?: (...args: unknown[]) => void
    })
  }

  export function instantiateNapiModuleSync(
    wasmModule: WebAssembly.Module,
    options?: NapiModuleOptions,
  ): unknown

  export class MessageHandler {
    constructor(options: {
      onLoad: (context: WorkerLoadContext) => unknown
      onError?: (error: unknown) => void
    })
    handle(event: MessageEvent): void
  }
}
