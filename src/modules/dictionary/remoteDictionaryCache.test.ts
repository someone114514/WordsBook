import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('reuses the manifest for consecutive lookups without changing matches', async () => {
  const rows = ['apple', 'apply', 'application'].map((headword) => ({ headword, headwordLower: headword }))
  const content = rows.map((row) => JSON.stringify(row)).join('\n')
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  const hash = Buffer.from(digest).toString('hex')
  const fetchMock = vi.fn(async (url: string) => new Response(url.endsWith('manifest.json')
    ? JSON.stringify({ buckets: [{ prefix: 'a', path: 'a.jsonl', sha256: '', contentSha256: hash }] })
    : content))
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('caches', { open: async () => ({ match: async () => undefined, put: async () => {} }) })
  const { lookupRemoteDictionary } = await import('./remoteDictionaryCache')
  expect((await lookupRemoteDictionary('app')).prefix.map((row) => row.headword)).toEqual(['apple', 'apply', 'application'])
  expect((await lookupRemoteDictionary('appl')).prefix).toHaveLength(3)
  expect((await lookupRemoteDictionary('apple')).exact[0]?.headword).toBe('apple')
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('manifest.json'))).toHaveLength(1)
  expect(fetchMock.mock.calls.filter(([url]) => !url.endsWith('manifest.json'))).toHaveLength(1)
})

it('allows retry after a manifest request fails', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ buckets: [] })))
  vi.stubGlobal('fetch', fetchMock)
  const { lookupRemoteDictionary } = await import('./remoteDictionaryCache')
  await expect(lookupRemoteDictionary('apple')).rejects.toThrow('503')
  await expect(lookupRemoteDictionary('apple')).resolves.toEqual({ exact: [], lemma: [], prefix: [] })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
