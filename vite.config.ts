import { defineConfig, loadEnv, type Plugin } from 'vite'
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
            if (!/^places\/[^/]+\/photos\/[^/]+$/.test(name)) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Invalid photo name' }))
              return
            }
            if (!apiKey.startsWith('AIza')) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Google Maps API key required' }))
              return
            }
            const upstream = await fetch(
              `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${maxWidthPx}&key=${encodeURIComponent(apiKey)}`,
              { redirect: 'follow' },
            )
            if (!upstream.ok) {
              res.statusCode = upstream.status
              res.end(JSON.stringify({ error: 'Photo fetch failed' }))
              return
            }
            const ct = upstream.headers.get('content-type') || 'image/jpeg'
            const buf = Buffer.from(await upstream.arrayBuffer())
            res.statusCode = 200
            res.setHeader('Content-Type', ct)
            res.setHeader('Cache-Control', 'public, max-age=86400')
            res.end(buf)
          } catch (err) {
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

      const handle = (
        path: string,
        run: (body: Record<string, unknown>) => Promise<unknown>,
      ) => {
        server.middlewares.use(path, (req, res, next) => {
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
                const payload = await run(body)
                res.statusCode = 200
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify(payload))
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

      handle('/api/places-nearby', async (body) => {
        const apiKey = resolveKey(body.apiKey)
        if (!apiKey) throw new Error('Google Maps API key required')
        const { searchNearbyPlacesGoogle, GOOGLE_NEARBY_MAX } = await import(
          './src/data/placesGoogle'
        )
        const places = await searchNearbyPlacesGoogle({
          lat: Number(body.lat),
          lon: Number(body.lon),
          radiusM: Number(body.radiusM) || 1500,
          maxResultCount: Math.min(
            Number(body.maxResultCount) || GOOGLE_NEARBY_MAX,
            GOOGLE_NEARBY_MAX,
          ),
          apiKey,
        })
        return { places }
      })

      handle('/api/places-text', async (body) => {
        const apiKey = resolveKey(body.apiKey)
        if (!apiKey) throw new Error('Google Maps API key required')
        const query = String(body.query || '').trim()
        if (!query) throw new Error('Missing query')
        const biasRaw = body.bias as { lat?: number; lon?: number; radiusM?: number } | undefined
        const bias =
          biasRaw && Number.isFinite(biasRaw.lat) && Number.isFinite(biasRaw.lon)
            ? {
                lat: Number(biasRaw.lat),
                lon: Number(biasRaw.lon),
                radiusM: biasRaw.radiusM,
              }
            : undefined
        const { searchTextPlaceGoogle } = await import('./src/data/placesGoogle')
        const place = await searchTextPlaceGoogle({ query, apiKey, bias })
        return { place }
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
    proxy: {
      '/api/overpass': {
        target: 'https://overpass-api.de',
        changeOrigin: true,
        rewrite: () => '/api/interpreter',
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader(
              'User-Agent',
              'trip-worker/0.1 (personal offline-first trip journal)',
            )
            proxyReq.setHeader('Accept', 'application/json')
          })
        },
      },
    },
  },
  preview: {
    port: 4173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    },
  },
}
})
