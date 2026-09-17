/**
 * Firebase app bootstrap (Auth + Firestore).
 * Configured via VITE_FIREBASE_* — optional until sharing is used.
 */

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app'
import { getAuth, type Auth } from 'firebase/auth'
import { getFirestore, type Firestore } from 'firebase/firestore'

export type FirebaseWebConfig = {
  apiKey: string
  authDomain: string
  projectId: string
  storageBucket?: string
  messagingSenderId?: string
  appId: string
}

function readConfig(): FirebaseWebConfig | null {
  const apiKey = String(import.meta.env.VITE_FIREBASE_API_KEY || '').trim()
  const authDomain = String(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '').trim()
  const projectId = String(import.meta.env.VITE_FIREBASE_PROJECT_ID || '').trim()
  const appId = String(import.meta.env.VITE_FIREBASE_APP_ID || '').trim()
  if (!apiKey || !authDomain || !projectId || !appId) return null
  return {
    apiKey,
    authDomain,
    projectId,
    storageBucket: String(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '').trim() || undefined,
    messagingSenderId:
      String(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '').trim() || undefined,
    appId,
  }
}

let app: FirebaseApp | null = null
let auth: Auth | null = null
let db: Firestore | null = null

export function isFirebaseConfigured(): boolean {
  return readConfig() != null
}

export function getFirebaseApp(): FirebaseApp | null {
  const cfg = readConfig()
  if (!cfg) return null
  if (!app) {
    app = getApps().length ? getApps()[0]! : initializeApp(cfg)
  }
  return app
}

export function getFirebaseAuth(): Auth | null {
  const a = getFirebaseApp()
  if (!a) return null
  if (!auth) auth = getAuth(a)
  return auth
}

export function getFirestoreDb(): Firestore | null {
  const a = getFirebaseApp()
  if (!a) return null
  if (!db) db = getFirestore(a)
  return db
}
