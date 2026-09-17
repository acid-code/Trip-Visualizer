/**
 * App identity via Firebase Auth + Google provider.
 * Invite allowlist matches auth.currentUser.email (verified).
 */

import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { doc, setDoc } from 'firebase/firestore'
import { getFirebaseAuth, getFirestoreDb, isFirebaseConfigured } from './firebaseApp'
import { normalizeEmail } from './emailNormalize'
import { nowIso } from './db'
import { logClientError } from './security'

export type CloudUser = {
  uid: string
  email: string
  displayName: string
  photoURL: string
  emailVerified: boolean
}

function toCloudUser(user: User): CloudUser | null {
  const email = normalizeEmail(user.email || '')
  if (!email) return null
  return {
    uid: user.uid,
    email,
    displayName: user.displayName || '',
    photoURL: user.photoURL || '',
    emailVerified: Boolean(user.emailVerified),
  }
}

function googleProvider() {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  provider.addScope('email')
  provider.addScope('profile')
  return provider
}

function isPopupAuthFailure(err: unknown): boolean {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code || '')
      : ''
  const msg = err instanceof Error ? err.message : String(err || '')
  return (
    code === 'auth/internal-error' ||
    code === 'auth/unauthorized-domain' ||
    code === 'auth/popup-blocked' ||
    code === 'auth/operation-not-supported-in-this-environment' ||
    /auth\/internal-error|unauthorized.domain|popup.?blocked/i.test(msg)
  )
}

async function finishGoogleSignIn(user: User): Promise<CloudUser> {
  const cloud = toCloudUser(user)
  if (!cloud) throw new Error('Google account has no email')
  const fromGoogle =
    user.providerData.some((p) => p.providerId === 'google.com') ||
    cloud.emailVerified
  if (!fromGoogle) {
    const auth = getFirebaseAuth()
    if (auth) await firebaseSignOut(auth)
    throw new Error('Google email is not verified — use a verified Google account')
  }
  await upsertUserProfile(cloud)
  return cloud
}

export function isCloudAuthConfigured(): boolean {
  return isFirebaseConfigured()
}

/** Subscribe to auth changes; returns unsubscribe. */
export function watchCloudAuth(onUser: (user: CloudUser | null) => void): () => void {
  const auth = getFirebaseAuth()
  if (!auth) {
    onUser(null)
    return () => {}
  }
  return onAuthStateChanged(auth, (user) => {
    onUser(user ? toCloudUser(user) : null)
  })
}

/**
 * Complete a redirect-based Google sign-in after the page reloads.
 * Call once on app boot (before or alongside watchCloudAuth).
 */
export async function completeGoogleRedirectSignIn(): Promise<CloudUser | null> {
  const auth = getFirebaseAuth()
  if (!auth) return null
  try {
    const cred = await getRedirectResult(auth)
    if (!cred?.user) return null
    return await finishGoogleSignIn(cred.user)
  } catch (err) {
    logClientError('share-signin-redirect', err)
    throw err
  }
}

export async function signInWithGoogle(): Promise<CloudUser> {
  const auth = getFirebaseAuth()
  if (!auth) throw new Error('Sharing is not configured — set VITE_FIREBASE_* env vars')
  const provider = googleProvider()
  try {
    const cred = await signInWithPopup(auth, provider)
    return await finishGoogleSignIn(cred.user)
  } catch (err) {
    // Preview / strict browsers often surface CSP or domain issues as internal-error.
    // Redirect avoids the popup/iframe path and usually works once the host is authorized.
    if (isPopupAuthFailure(err)) {
      logClientError('share-signin-popup', err)
      await signInWithRedirect(auth, provider)
      // Navigation away — caller won't use the return value
      return new Promise(() => {})
    }
    throw err
  }
}

export async function signOutCloud(): Promise<void> {
  const auth = getFirebaseAuth()
  if (!auth) return
  await firebaseSignOut(auth)
}

export function requireCloudUser(): CloudUser {
  const auth = getFirebaseAuth()
  const user = auth?.currentUser
  if (!user) throw new Error('Sign in with Google first')
  const cloud = toCloudUser(user)
  if (!cloud) throw new Error('Google account has no email')
  return cloud
}

async function upsertUserProfile(user: CloudUser): Promise<void> {
  const db = getFirestoreDb()
  if (!db) return
  await setDoc(
    doc(db, 'users', user.uid),
    {
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      updatedAt: nowIso(),
    },
    { merge: true },
  )
}
