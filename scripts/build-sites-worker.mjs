import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Sites serves the contents of dist/ through the ASSETS binding. This worker
// keeps the SPA fallback working for deep links while leaving all app logic
// client-side and offline-first.
const worker = `function withLearningEngineHeaders(response) {
  const headers = new Headers(response.headers)
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const worker = {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request)
    if (response.status !== 404) return withLearningEngineHeaders(response)

    const acceptsHtml = request.headers.get('accept')?.includes('text/html')
    if (!acceptsHtml) return withLearningEngineHeaders(response)

    const fallback = new URL('/index.html', request.url)
    return withLearningEngineHeaders(await env.ASSETS.fetch(new Request(fallback, request)))
  },
}

export default worker
`

const outputDir = resolve('dist/server')
await mkdir(outputDir, { recursive: true })
await writeFile(resolve(outputDir, 'index.js'), worker, 'utf8')
