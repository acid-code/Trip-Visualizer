/**
 * App identity via Firebase Auth + Google provider.
 * Invite allowlist matches auth.currentUser.email (verified).
 */

import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { doc, setDoc } from 'firebase/firestore'
import { getFirebaseAuth, getFirestoreDb, isFirebaseConfigured } from './firebaseApp'
import { normalizeEmail } from './emailNormalize'
import { nowIso } from './db'

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

export async function signInWithGoogle(): Promise<CloudUser> {
  const auth = getFirebaseAuth()
  if (!auth) throw new Error('Sharing is not configured — set VITE_FIREBASE_* env vars')
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  provider.addScope('email')
  provider.addScope('profile')
  const cred = await signInWithPopup(auth, provider)
  const cloud = toCloudUser(cred.user)
  if (!cloud) throw new Error('Google account has no email')
  // Google sign-in provider implies a verified mailbox for our allowlist.
  const fromGoogle =
    cred.user.providerData.some((p) => p.providerId === 'google.com') ||
    cloud.emailVerified
  if (!fromGoogle) {
    await firebaseSignOut(auth)
    throw new Error('Google email is not verified — use a verified Google account')
  }
  await upsertUserProfile(cloud)
  return cloud
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
