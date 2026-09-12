/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const CESIUM_BASE_URL: string
declare const __APP_BUILD_ID__: string

interface ImportMetaEnv {
  readonly VITE_GOOGLE_OAUTH_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}