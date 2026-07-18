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
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          globPatterns: ['**/*.{js,css,html,svg,png,webp,json}'],
          runtimeCaching: [
            {
              urlPattern: ({ request }) => request.destination === 'document',
              handler: 'NetworkFirst',
              options: {
                cacheName: 'pages',
                networkTimeoutSeconds: 1,
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
          // The dev SW folder only contains sw.js/workbox-*.js, which Workbox
          // intentionally ignores. Use the plugin's dev-only placeholder glob
          // so an empty precache does not emit a false-positive warning.
          suppressWarnings: true,
        },
      }),
    ],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('/node_modules/ts-fsrs/') || id.includes('\\node_modules\\ts-fsrs\\')) {
              return 'fsrs'
            }
            if (id.includes('/node_modules/@supabase/') || id.includes('\\node_modules\\@supabase\\')) {
              return 'supabase'
            }
            if (id.includes('/node_modules/dexie/') || id.includes('\\node_modules\\dexie\\')) {
              return 'storage'
            }
            if (
              id.includes('/node_modules/vue/') || id.includes('\\node_modules\\vue\\')
              || id.includes('/node_modules/@vue/') || id.includes('\\node_modules\\@vue\\')
              || id.includes('/node_modules/pinia/') || id.includes('\\node_modules\\pinia\\')
              || id.includes('/node_modules/vue-router/') || id.includes('\\node_modules\\vue-router\\')
            ) {
              return 'vue-vendor'
            }
          },
        },
      },
    },
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
