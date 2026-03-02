import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(() => {
  const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1]
  const isGithubActions = process.env.GITHUB_ACTIONS === 'true'
  const normalizedBase = process.env.VITE_APP_BASE
    ? process.env.VITE_APP_BASE
    : isGithubActions && repoName
      ? `/${repoName}/`
      : '/'
  const base = normalizedBase.endsWith('/') ? normalizedBase : `${normalizedBase}/`
  const dictionaryPrefix = `${base.replace(/\/$/, '')}/dictionaries/`

  return {
    base,
    plugins: [
      vue(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icons/icon-192.svg', 'icons/icon-512.svg'],
        manifest: {
          id: base,
          name: 'WordsBook',
          short_name: 'WordsBook',
          description: 'Offline-first dictionary and spaced repetition word book.',
          theme_color: '#f4f7ff',
          background_color: '#f4f7ff',
          display: 'standalone',
          scope: base,
          start_url: base,
          icons: [
            {
              src: 'icons/icon-192.svg',
              sizes: '192x192',
              type: 'image/svg+xml',
              purpose: 'any',
            },
            {
              src: 'icons/icon-512.svg',
              sizes: '512x512',
              type: 'image/svg+xml',
              purpose: 'any maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,webp,json}'],
          runtimeCaching: [
            {
              urlPattern: ({ request }) => request.destination === 'document',
              handler: 'NetworkFirst',
              options: {
                cacheName: 'pages',
                networkTimeoutSeconds: 3,
                expiration: { maxEntries: 50 },
              },
            },
            {
              urlPattern: ({ url }) => url.pathname.startsWith(dictionaryPrefix),
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'dictionary-assets',
                expiration: { maxEntries: 200 },
              },
            },
            {
              urlPattern: ({ request }) => ['style', 'script', 'worker'].includes(request.destination),
              handler: 'CacheFirst',
              options: {
                cacheName: 'app-shell',
                expiration: { maxEntries: 100 },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
        },
      }),
    ],
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.ts'],
      coverage: {
        provider: 'v8' as const,
        reporter: ['text', 'html'],
      },
    },
  }
})
