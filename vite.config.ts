import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Preview deploys behind Vercel SSO break /manifest.webmanifest (CORS) — skip PWA there. */
const disablePwa = process.env.VERCEL_ENV === 'preview'

/** Dev-only Places proxies (same contract as /api/places-* on Vercel). */
function placesDevProxy(): Plugin {
  return {
    name: 'places-dev-proxy',
    configureServer(server) {
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
        const apiKey = String(
          body.apiKey ||
            process.env.GOOGLE_MAPS_API_KEY ||
            process.env.VITE_GOOGLE_MAPS_API_KEY ||
            '',
        ).trim()
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
        const apiKey = String(
          body.apiKey ||
            process.env.GOOGLE_MAPS_API_KEY ||
            process.env.VITE_GOOGLE_MAPS_API_KEY ||
            '',
        ).trim()
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

export default defineConfig({
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
    VitePWA({
      disable: disablePwa,
      registerType: 'autoUpdate',
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
        globPatterns: ['**/*.{js,css,html,ico,svg,json,woff2}'],
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
})
