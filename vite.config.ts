import { defineConfig } from 'vitest/config'
import { loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Preview deploys behind Vercel SSO break /manifest.webmanifest (CORS) — skip PWA there. */
const disablePwa = process.env.VERCEL_ENV === 'preview'

/** Stable per deploy (Vercel commit) or unique local build id. */
const appBuildId =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.VITE_APP_BUILD_ID ||
  `local-${Date.now()}`

/** Emit `/version.json` so clients can detect a new deployment without hard refresh. */
function emitBuildVersion(): Plugin {
  return {
    name: 'emit-build-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({
          buildId: appBuildId,
          builtAt: new Date().toISOString(),
        }),
      })
    },
  }
}

/** Dev-only Places proxies (same contract as /api/places-* on Vercel). */
function placesDevProxy(): Plugin {
  const resolveKey = (bodyKey?: unknown) => {
    const fromBody = String(bodyKey ?? '').trim()
    if (fromBody.startsWith('AIza')) return fromBody
    return String(process.env.GOOGLE_MAPS_API_KEY ?? '').trim()
  }

  return {
    name: 'places-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/maps-status', (req, res, next) => {
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        if (req.method !== 'GET') {
          next()
          return
        }
        const key = String(process.env.GOOGLE_MAPS_API_KEY ?? '').trim()
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ placesConfigured: key.startsWith('AIza') }))
      })

      server.middlewares.use('/api/places-photo', (req, res, next) => {
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        if (req.method !== 'GET') {
          next()
          return
        }
        void (async () => {
          try {
            const url = new URL(req.url || '', 'http://localhost')
            const name = (url.searchParams.get('name') || '').replace(/^\//, '')
            const maxWidthPx = Math.min(
              Math.max(Number(url.searchParams.get('maxWidthPx')) || 640, 1),
              1600,
            )
            const apiKey = resolveKey()
            if (!/^places\/[^/]+\/photos\/.+$/.test(name)) {
              console.error('[places-photo] invalid name', {
                len: name.length,
                prefix: name.slice(0, 64),
              })
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Invalid photo name' }))
              return
            }
            if (!apiKey.startsWith('AIza')) {
              console.error('[places-photo] missing GOOGLE_MAPS_API_KEY')
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Google Maps API key required' }))
              return
            }
            const upstream = await fetch(
              `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${maxWidthPx}&key=${encodeURIComponent(apiKey)}`,
              { redirect: 'follow' },
            )
            if (!upstream.ok) {
              const body = await upstream.text().catch(() => '')
              console.error('[places-photo] upstream failed', {
                status: upstream.status,
                nameLen: name.length,
                truncatedLegacy: name.length >= 250 && name.length <= 256,
                body: body.slice(0, 200),
              })
              res.statusCode = upstream.status
              res.setHeader('Content-Type', 'application/json')
              res.end(
                JSON.stringify({
                  error: `Photo fetch failed (${upstream.status})`,
                }),
              )
              return
            }
            const ct = upstream.headers.get('content-type') || 'image/jpeg'
            const buf = Buffer.from(await upstream.arrayBuffer())
            res.statusCode = 200
            res.setHeader('Content-Type', ct)
            res.setHeader('Cache-Control', 'public, max-age=86400')
            res.end(buf)
          } catch (err) {
            console.error('[places-photo] proxy error', err)
            res.statusCode = 502
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : 'Photo proxy failed',
              }),
            )
          }
        })()
      })

      const mountApiPost = (route: string, apiFile: string) => {
        server.middlewares.use(route, (req, res, next) => {
          if (req.method === 'OPTIONS') {
            res.statusCode = 204
            res.end()
            return
          }
          if (req.method !== 'POST') {
            next()
            return
          }
          const chunks: Buffer[] = []
          req.on('data', (c) => chunks.push(c as Buffer))
          req.on('end', () => {
            void (async () => {
              try {
                const raw = Buffer.concat(chunks).toString('utf8')
                const body = JSON.parse(raw || '{}') as Record<string, unknown>
                // Absolute path + ssrLoadModule: relative import() resolves under .vite-temp.
                const mod = await server.ssrLoadModule(
                  path.resolve(__dirname, apiFile),
                )
                const handler = mod.default as (
                  req: {
                    method?: string
                    body?: unknown
                    headers?: Record<string, string | string[] | undefined>
                  },
                  res: {
                    status: (code: number) => unknown
                    setHeader: (name: string, value: string) => void
                    json: (body: unknown) => void
                    send: (body: string) => void
                  },
                ) => Promise<void>
                const fakeRes = {
                  statusCode: 200,
                  status(code: number) {
                    this.statusCode = code
                    return this
                  },
                  setHeader(name: string, value: string) {
                    res.setHeader(name, value)
                  },
                  json(payload: unknown) {
                    res.statusCode = this.statusCode
                    res.setHeader('Content-Type', 'application/json')
                    res.end(JSON.stringify(payload))
                  },
                  send(payload: string) {
                    res.statusCode = this.statusCode
                    res.end(payload)
                  },
                }
                await handler(
                  {
                    method: 'POST',
                    body,
                    headers: {
                      origin: String(req.headers.origin || ''),
                      referer: String(req.headers.referer || ''),
                    },
                  },
                  fakeRes,
                )
              } catch (err) {
                res.statusCode = 502
                res.setHeader('Content-Type', 'application/json')
                res.end(
                  JSON.stringify({
                    error: err instanceof Error ? err.message : 'Places request failed',
                  }),
                )
              }
            })()
          })
        })
      }

      // Use standalone /api handlers (not src/data) — client modules touch import.meta.env.
      mountApiPost('/api/places-nearby', 'api/places-nearby.ts')
      mountApiPost('/api/places-text', 'api/places-text.ts')

      // Same multi-mirror Overpass handler as Vercel (Vite http-proxy only hit one host).
      server.middlewares.use('/api/overpass', (req, res, next) => {
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        if (req.method !== 'POST') {
          next()
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c as Buffer))
        req.on('end', () => {
          void (async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8')
              const handler = (await import('./api/overpass')).default
              const fakeRes = {
                statusCode: 200,
                status(code: number) {
                  this.statusCode = code
                  return this
                },
                setHeader(name: string, value: string) {
                  res.setHeader(name, value)
                },
                json(payload: unknown) {
                  res.statusCode = this.statusCode
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify(payload))
                },
                send(payload: string) {
                  res.statusCode = this.statusCode
                  res.end(payload)
                },
              }
              await handler({ method: 'POST', body: raw }, fakeRes)
            } catch (err) {
              res.statusCode = 502
              res.setHeader('Content-Type', 'application/json')
              res.end(
                JSON.stringify({
                  error: err instanceof Error ? err.message : 'Overpass proxy failed',
                }),
              )
            }
          })()
        })
      })

      server.middlewares.use('/api/ai-coach', (req, res, next) => {
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        if (req.method !== 'POST') {
          next()
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c as Buffer))
        req.on('end', () => {
          void (async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8')
              const body = JSON.parse(raw || '{}') as Record<string, unknown>
              const handler = (await import('./api/ai-coach')).default
              const fakeRes = {
                statusCode: 200,
                status(code: number) {
                  this.statusCode = code
                  return this
                },
                setHeader() {},
                json(payload: unknown) {
                  res.statusCode = this.statusCode
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify(payload))
                },
                send(payload: string) {
                  res.statusCode = this.statusCode
                  res.end(payload)
                },
              }
              await handler({ method: 'POST', body, headers: req.headers as never }, fakeRes)
            } catch (err) {
              res.statusCode = 502
              res.setHeader('Content-Type', 'application/json')
              res.end(
                JSON.stringify({
                  error: err instanceof Error ? err.message : 'AI coach failed',
                }),
              )
            }
          })()
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Non-VITE_ secrets (e.g. GOOGLE_MAPS_API_KEY) are not on process.env unless we load them.
  const env = loadEnv(mode, process.cwd(), '')
  if (env.GOOGLE_MAPS_API_KEY) {
    process.env.GOOGLE_MAPS_API_KEY = env.GOOGLE_MAPS_API_KEY
  }
  if (env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = env.GEMINI_API_KEY
  }

  return {
  plugins: [
    react(),
    tailwindcss(),
    placesDevProxy(),
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/cesium/Build/Cesium/Workers/**/*',
          dest: 'cesium/Workers',
        },
        {
          src: 'node_modules/cesium/Build/Cesium/ThirdParty/**/*',
          dest: 'cesium/ThirdParty',
        },
        {
          src: 'node_modules/cesium/Build/Cesium/Assets/**/*',
          dest: 'cesium/Assets',
        },
        {
          src: 'node_modules/cesium/Build/Cesium/Widgets/**/*',
          dest: 'cesium/Widgets',
        },
      ],
    }),
    emitBuildVersion(),
    VitePWA({
      disable: disablePwa,
      registerType: 'autoUpdate',
      // Registered from `src/updateCheck.ts` so we can poll for updates.
      injectRegister: false,
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Trip Tracker',
        short_name: 'TripTrack',
        description: 'Personal trip tracker with Excel sync and globe visualizations',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        // Keep version.json out of the precache so clients always hit the network.
        globPatterns: ['**/*.{js,css,html,ico,svg,woff2}'],
        globIgnores: ['**/version.json'],
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  define: {
    CESIUM_BASE_URL: JSON.stringify('/cesium'),
    __APP_BUILD_ID__: JSON.stringify(appBuildId),
  },
  optimizeDeps: {
    include: ['cesium', 'mersenne-twister'],
    // MapLibre v6 worker fails Vite dep pre-bundle (missing maplibre-gl-worker.mjs).
    exclude: ['maplibre-gl'],
  },
  build: {
    chunkSizeWarningLimit: 7000,
    commonjsOptions: {
      include: [/mersenne-twister/, /node_modules/],
    },
  },
  server: {
    port: 5173,
    // GIS OAuth popup needs this — vercel.json headers do not apply in Vite dev.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    },
    // /api/overpass is handled in placesDevProxy (multi-mirror), not http-proxy.
  },
  preview: {
    port: 4173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}
})
