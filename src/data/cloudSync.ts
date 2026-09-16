/**
 * Near-live trip sharing via Firestore.
 * Syncs full TripRecord (Journey items + Plan sections/places).
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  setDoc,
  updateDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore'
import {
  sanitizeTripRecord,
  type TripRecord,
} from '../domain/types'
import { nowIso } from './db'
import { requireCloudUser, type CloudUser } from './cloudAuth'
import { emailDocKey, isValidInviteEmail, normalizeEmail } from './emailNormalize'
import { getFirestoreDb } from './firebaseApp'
import { forFirestore, shareErrorMessage } from './shareErrors'
import type { CloudTripDoc, TripInvite, TripMember } from './shareTypes'

export { shareErrorMessage }

function dbOrThrow() {
  const db = getFirestoreDb()
  if (!db) throw new Error('Sharing is not configured — set VITE_FIREBASE_* env vars')
  return db
}

/**
 * Firestore forbids nested arrays. Encode routeCoords [lat,lon][] as {lat,lon}[].
 */
function encodeRecordForFirestore(trip: TripRecord): unknown {
  return forFirestore({
    ...trip,
    items: trip.items.map((item) => ({
      ...item,
      routeCoords: (item.routeCoords ?? []).map(([lat, lon]) => ({ lat, lon })),
    })),
  })
}

function decodeRecordFromFirestore(raw: unknown): TripRecord {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const itemsIn = Array.isArray(obj.items) ? obj.items : []
  const items = itemsIn.map((item) => {
    if (!item || typeof item !== 'object') return item
    const it = item as Record<string, unknown>
    const coords = it.routeCoords
    if (!Array.isArray(coords)) return it
    const routeCoords = coords
      .map((c) => {
        if (Array.isArray(c) && c.length >= 2) {
          return [Number(c[0]), Number(c[1])] as [number, number]
        }
        if (c && typeof c === 'object') {
          const o = c as { lat?: unknown; lon?: unknown }
          return [Number(o.lat), Number(o.lon)] as [number, number]
        }
        return null
      })
      .filter((c): c is [number, number] =>
        Boolean(c && Number.isFinite(c[0]) && Number.isFinite(c[1])),
      )
    return { ...it, routeCoords }
  })
  return sanitizeTripRecord({ ...obj, items })
}

/** Strip local-only noise; keep Journey + Plan for round-trip. */
export function tripRecordForCloud(trip: TripRecord): TripRecord {
  return sanitizeTripRecord({
    ...trip,
    cloudTripId: trip.cloudTripId || trip.id,
    revision: trip.revision ?? 0,
  })
}

function cloudTripPayload(trip: TripRecord, meta: Omit<CloudTripDoc, 'record'>): CloudTripDoc {
  return {
    ...meta,
    record: encodeRecordForFirestore(trip),
  }
}

export function isTripShared(trip: TripRecord | null | undefined): boolean {
  return Boolean(trip?.cloudTripId && trip.shareEnabled)
}

export async function enableTripSharing(trip: TripRecord): Promise<TripRecord> {
  const user = requireCloudUser()
  const db = dbOrThrow()
  const tripId = trip.id
  const revision = (trip.revision ?? 0) + 1
  const record = tripRecordForCloud({
    ...trip,
    cloudTripId: tripId,
    shareEnabled: true,
    shareOwnerUid: user.uid,
    shareOwnerEmail: user.email,
    revision,
    updatedAt: nowIso(),
  })

  const tripDoc = cloudTripPayload(record, {
    ownerUid: user.uid,
    ownerEmail: user.email,
    revision,
    updatedAt: record.updatedAt,
    lastWriterUid: user.uid,
  })

  const memberDoc = forFirestore({
    uid: user.uid,
    email: user.email,
    role: 'owner',
    status: 'active',
    joinedAt: nowIso(),
  } satisfies TripMember)

  // Sequential writes: trip first so membership rules can see the owner.
  try {
    await setDoc(doc(db, 'trips', tripId), tripDoc)
    await setDoc(doc(db, 'trips', tripId, 'members', user.uid), memberDoc)
  } catch (err) {
    // Preserve Firebase code for UI mapping; attach friendly text.
    const friendly = shareErrorMessage(err, 'Could not enable sharing')
    const wrapped = new Error(friendly) as Error & { cause?: unknown; code?: string }
    wrapped.cause = err
    if (err && typeof err === 'object' && 'code' in err) {
      wrapped.code = String((err as { code?: string }).code || '')
    }
    throw wrapped
  }
  return record
}

export async function pushSharedTrip(
  trip: TripRecord,
  opts?: { expectedRevision?: number },
): Promise<TripRecord> {
  const user = requireCloudUser()
  const db = dbOrThrow()
  if (!isTripShared(trip) || !trip.cloudTripId) {
    throw new Error('Trip is not shared')
  }
  const tripId = trip.cloudTripId
  const remote = await getDoc(doc(db, 'trips', tripId))
  if (!remote.exists()) throw new Error('Shared trip not found in cloud')
  const remoteData = remote.data() as CloudTripDoc
  if (
    opts?.expectedRevision != null &&
    remoteData.revision > opts.expectedRevision &&
    remoteData.lastWriterUid !== user.uid
  ) {
    const err = new Error('PARTNER_UPDATED') as Error & { remote: TripRecord }
    err.remote = decodeRecordFromFirestore(remoteData.record)
    throw err
  }

  const revision = Math.max(remoteData.revision, trip.revision ?? 0) + 1
  const record = tripRecordForCloud({
    ...trip,
    cloudTripId: tripId,
    shareEnabled: true,
    shareOwnerUid: trip.shareOwnerUid || remoteData.ownerUid,
    shareOwnerEmail: trip.shareOwnerEmail || remoteData.ownerEmail,
    revision,
    updatedAt: nowIso(),
  })

  await setDoc(
    doc(db, 'trips', tripId),
    cloudTripPayload(record, {
      ownerUid: remoteData.ownerUid,
      ownerEmail: remoteData.ownerEmail,
      revision,
      updatedAt: record.updatedAt,
      lastWriterUid: user.uid,
    }),
    { merge: false },
  )
  return record
}

export async function pullSharedTrip(tripId: string): Promise<TripRecord | null> {
  const db = dbOrThrow()
  requireCloudUser()
  const snap = await getDoc(doc(db, 'trips', tripId))
  if (!snap.exists()) return null
  const data = snap.data() as CloudTripDoc
  return decodeRecordFromFirestore(data.record)
}

export function watchSharedTrip(
  tripId: string,
  onTrip: (trip: TripRecord) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const db = dbOrThrow()
  return onSnapshot(
    doc(db, 'trips', tripId),
    (snap) => {
      if (!snap.exists()) return
      try {
        const data = snap.data() as CloudTripDoc
        onTrip(decodeRecordFromFirestore(data.record))
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error('Invalid shared trip'))
      }
    },
    (err) => onError?.(err),
  )
}

export async function inviteToTrip(
  trip: TripRecord,
  rawEmail: string,
): Promise<TripInvite> {
  const user = requireCloudUser()
  const db = dbOrThrow()
  if (!isTripShared(trip) || !trip.cloudTripId) {
    throw new Error('Enable sharing on this trip first')
  }
  if (trip.shareOwnerUid && trip.shareOwnerUid !== user.uid) {
    throw new Error('Only the trip owner can invite')
  }
  if (!isValidInviteEmail(rawEmail)) throw new Error('Enter a valid email address')
  const email = normalizeEmail(rawEmail)
  if (email === user.email) throw new Error('You already own this trip')
  const key = emailDocKey(email)
  if (!key) throw new Error('Enter a valid email address')

  const tripId = trip.cloudTripId
  const invite: TripInvite = {
    tripId,
    tripName: trip.meta.name || 'Shared trip',
    email,
    role: 'editor',
    status: 'pending',
    invitedByUid: user.uid,
    invitedByEmail: user.email,
    invitedAt: nowIso(),
  }

  const batch = writeBatch(db)
  batch.set(doc(db, 'trips', tripId, 'invites', key), forFirestore(invite))
  batch.set(doc(db, 'emailInvites', key, 'trips', tripId), forFirestore(invite))
  await batch.commit()
  return invite
}

export async function listTripInvites(tripId: string): Promise<TripInvite[]> {
  const db = dbOrThrow()
  requireCloudUser()
  const snap = await getDocs(collection(db, 'trips', tripId, 'invites'))
  return snap.docs
    .map((d) => d.data() as TripInvite)
    .filter((i) => i.status === 'pending' || i.status === 'accepted')
}

export async function listTripMembers(tripId: string): Promise<TripMember[]> {
  const db = dbOrThrow()
  requireCloudUser()
  const snap = await getDocs(collection(db, 'trips', tripId, 'members'))
  return snap.docs
    .map((d) => d.data() as TripMember)
    .filter((m) => m.status === 'active')
}

export async function listMyPendingInvites(): Promise<TripInvite[]> {
  const user = requireCloudUser()
  const db = dbOrThrow()
  const key = emailDocKey(user.email)
  if (!key) return []
  const snap = await getDocs(collection(db, 'emailInvites', key, 'trips'))
  return snap.docs
    .map((d) => d.data() as TripInvite)
    .filter((i) => i.status === 'pending' && normalizeEmail(i.email) === user.email)
}

export async function acceptInvite(tripId: string): Promise<TripRecord> {
  const user = requireCloudUser()
  const db = dbOrThrow()
  const key = emailDocKey(user.email)
  if (!key) throw new Error('Invalid account email')

  const inviteRef = doc(db, 'emailInvites', key, 'trips', tripId)
  const inviteSnap = await getDoc(inviteRef)
  if (!inviteSnap.exists()) throw new Error('Invite not found for this Google account')
  const invite = inviteSnap.data() as TripInvite
  if (normalizeEmail(invite.email) !== user.email) {
    throw new Error('This invite is for a different email')
  }
  if (invite.status === 'revoked') throw new Error('This invite was revoked')
  if (invite.status !== 'pending' && invite.status !== 'accepted') {
    throw new Error('Invite is no longer valid')
  }

  const member: TripMember = {
    uid: user.uid,
    email: user.email,
    role: invite.role === 'owner' ? 'editor' : invite.role,
    status: 'active',
    joinedAt: nowIso(),
  }
  const accepted: TripInvite = {
    ...invite,
    status: 'accepted',
    acceptedUid: user.uid,
  }

  const batch = writeBatch(db)
  batch.set(doc(db, 'trips', tripId, 'members', user.uid), forFirestore(member))
  batch.set(doc(db, 'trips', tripId, 'invites', key), forFirestore(accepted))
  batch.set(inviteRef, forFirestore(accepted))
  await batch.commit()

  const trip = await pullSharedTrip(tripId)
  if (!trip) throw new Error('Could not load shared trip')
  return {
    ...trip,
    cloudTripId: tripId,
    shareEnabled: true,
  }
}

export async function revokeInvite(trip: TripRecord, rawEmail: string): Promise<void> {
  const user = requireCloudUser()
  const db = dbOrThrow()
  if (!trip.cloudTripId) throw new Error('Trip is not shared')
  if (trip.shareOwnerUid && trip.shareOwnerUid !== user.uid) {
    throw new Error('Only the trip owner can revoke access')
  }
  const email = normalizeEmail(rawEmail)
  const key = emailDocKey(email)
  if (!key) throw new Error('Invalid email')

  const tripId = trip.cloudTripId
  const inviteRef = doc(db, 'trips', tripId, 'invites', key)
  const inviteSnap = await getDoc(inviteRef)
  const prev = inviteSnap.exists() ? (inviteSnap.data() as TripInvite) : null

  const revoked: TripInvite = {
    tripId,
    tripName: trip.meta.name || 'Shared trip',
    email,
    role: prev?.role || 'editor',
    status: 'revoked',
    invitedByUid: prev?.invitedByUid || user.uid,
    invitedByEmail: prev?.invitedByEmail || user.email,
    invitedAt: prev?.invitedAt || nowIso(),
    acceptedUid: prev?.acceptedUid,
  }

  const batch = writeBatch(db)
  batch.set(inviteRef, revoked)
  batch.set(doc(db, 'emailInvites', key, 'trips', tripId), revoked)
  if (prev?.acceptedUid) {
    batch.set(
      doc(db, 'trips', tripId, 'members', prev.acceptedUid),
      {
        uid: prev.acceptedUid,
        email,
        role: prev.role || 'editor',
        status: 'revoked',
        joinedAt: nowIso(),
      } satisfies TripMember,
      { merge: true },
    )
  }
  await batch.commit()
}

export async function stopSharing(trip: TripRecord): Promise<TripRecord> {
  const user = requireCloudUser()
  const db = dbOrThrow()
  if (!trip.cloudTripId) return { ...trip, shareEnabled: false, cloudTripId: '' }
  if (trip.shareOwnerUid && trip.shareOwnerUid !== user.uid) {
    throw new Error('Only the trip owner can stop sharing')
  }
  // Soft-stop: mark trip unshared locally; revoke open invites.
  const invites = await listTripInvites(trip.cloudTripId)
  for (const inv of invites) {
    if (inv.status === 'pending' || inv.status === 'accepted') {
      await revokeInvite(trip, inv.email)
    }
  }
  await updateDoc(doc(db, 'trips', trip.cloudTripId), {
    updatedAt: nowIso(),
    lastWriterUid: user.uid,
  })
  return {
    ...trip,
    shareEnabled: false,
    cloudTripId: trip.cloudTripId,
    updatedAt: nowIso(),
  }
}

export function canManageShare(trip: TripRecord, user: CloudUser | null): boolean {
  if (!user || !isTripShared(trip)) return false
  return !trip.shareOwnerUid || trip.shareOwnerUid === user.uid
}
