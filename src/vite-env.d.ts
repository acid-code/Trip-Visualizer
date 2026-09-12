/// <reference types="vite/client" />

declare const CESIUM_BASE_URL: string

interface ImportMetaEnv {
  /** Default Google Maps / Places key (Vercel env or local `.env`). Overridable in Data. */
  readonly VITE_GOOGLE_MAPS_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
