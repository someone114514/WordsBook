import { instantiateNapiModuleSync, MessageHandler, WASI } from '@napi-rs/wasm-runtime'

const errorOutputs: unknown[][] = []

const handler = new MessageHandler({
  onLoad({ wasmModule, wasmMemory }) {
    const wasi = new WASI({
      print: (...args: unknown[]) => console.log(...args),
      printErr: (...args: unknown[]) => {
        console.error(...args)
        errorOutputs.push(args)
      },
    })
    return instantiateNapiModuleSync(wasmModule, {
      childThread: true,
      wasi,
      overwriteImports(importObject) {
        importObject.env = {
          ...importObject.env,
          ...importObject.napi,
          ...importObject.emnapi,
          memory: wasmMemory,
        }
      },
    })
  },
  onError(error) {
    globalThis.postMessage({ type: 'error', error, errorOutputs: [...errorOutputs] })
    errorOutputs.length = 0
  },
})

globalThis.onmessage = (event: MessageEvent) => {
  handler.handle(event)
}
