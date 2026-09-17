/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const CESIUM_BASE_URL: string
declare const __APP_BUILD_ID__: string

interface ImportMetaEnv {
  readonly VITE_GOOGLE_OAUTH_CLIENT_ID?: string
  readonly VITE_FIREBASE_API_KEY?: string
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
  readonly VITE_FIREBASE_PROJECT_ID?: string
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string
  readonly VITE_FIREBASE_APP_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*?worker&url' {
  const workerUrl: string
  export default workerUrl
}