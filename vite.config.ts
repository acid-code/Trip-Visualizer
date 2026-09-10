import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
  },
})
