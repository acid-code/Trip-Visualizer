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
  runTransaction,
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

export const SHARE_GONE = 'SHARE_GONE'

function dbOrThrow() {
  const db = getFirestoreDb()
  if (!db) throw new Error('Sharing is not configured — set VITE_FIREBASE_* env vars')
  return db
}

function requireOwner(trip: TripRecord, user: CloudUser) {
  if (!trip.shareOwnerUid || trip.shareOwnerUid !== user.uid) {
    throw new Error('Only the trip owner can manage sharing')
  }
}

/**
 * Firestore forbids nested arrays. Encode routeCoords [lat,lon][] as {lat,lon}[].
 * Exported for unit tests.
 */
export function encodeRecordForFirestore(trip: TripRecord): unknown {
  return forFirestore({
    ...trip,
    items: trip.items.map((item) => ({
      ...item,
      routeCoords: (item.routeCoords ?? []).map(([lat, lon]) => ({ lat, lon })),
    })),
  })
}

/** Decode a cloud payload back into a sanitized TripRecord. Exported for unit tests. */
export function decodeRecordFromFirestore(raw: unknown): TripRecord {
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
  return forFirestore({
    ...meta,
    record: encodeRecordForFirestore(trip),
  }) as CloudTripDoc
}

export function isTripShared(trip: TripRecord | null | undefined): boolean {
  return Boolean(trip?.cloudTripId && trip.shareEnabled)
}

/** Local copy kept; share flags cleared (device-only after leave/revoke/gone). */
export function clearLocalShare(trip: TripRecord): TripRecord {
  return {
    ...trip,
    shareEnabled: false,
    cloudTripId: '',
    shareOwnerUid: '',
    shareOwnerEmail: '',
    updatedAt: nowIso(),
  }
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
  const tripRef = doc(db, 'trips', tripId)

  try {
    return await runTransaction(db, async (tx) => {
      const remote = await tx.get(tripRef)
      if (!remote.exists()) throw new Error('Shared trip not found in cloud')
      const remoteData = remote.data() as CloudTripDoc

      // Any remote revision ahead of what we based on is a conflict —
      // including same-user multi-device (no lastWriterUid bypass).
      if (
        opts?.expectedRevision != null &&
        remoteData.revision > opts.expectedRevision
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

      tx.set(
        tripRef,
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
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'PARTNER_UPDATED') throw err
    throw err
  }
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
      if (!snap.exists()) {
        const gone = new Error(SHARE_GONE) as Error & { code: string }
        gone.code = SHARE_GONE
        onError?.(gone)
        return
      }
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
  requireOwner(trip, user)
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

/** All invite docs including revoked (for cascade cleanup). */
async function listAllTripInvites(tripId: string): Promise<TripInvite[]> {
  const db = dbOrThrow()
  const snap = await getDocs(collection(db, 'trips', tripId, 'invites'))
  return snap.docs.map((d) => d.data() as TripInvite)
}

export async function listTripMembers(tripId: string): Promise<TripMember[]> {
  const db = dbOrThrow()
  requireCloudUser()
  const snap = await getDocs(collection(db, 'trips', tripId, 'members'))
  return snap.docs
    .map((d) => d.data() as TripMember)
    .filter((m) => m.status === 'active')
}

/** Active + revoked members (for cascade cleanup / stop). */
async function listAllTripMembers(tripId: string): Promise<TripMember[]> {
  const db = dbOrThrow()
  const snap = await getDocs(collection(db, 'trips', tripId, 'members'))
  return snap.docs.map((d) => d.data() as TripMember)
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

  // Fresh accept only from pending (rules also enforce). Re-pull if already accepted.
  if (invite.status === 'accepted') {
    const existing = await pullSharedTrip(tripId)
    if (!existing) throw new Error('Could not load shared trip')
    return {
      ...existing,
      cloudTripId: tripId,
      shareEnabled: true,
    }
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

async function writeRevokedInvite(
  trip: TripRecord,
  email: string,
  prev: TripInvite | null,
  memberUid?: string,
): Promise<void> {
  const user = requireCloudUser()
  const db = dbOrThrow()
  const tripId = trip.cloudTripId!
  const key = emailDocKey(email)
  if (!key) throw new Error('Invalid email')

  const revoked: TripInvite = {
    tripId,
    tripName: trip.meta.name || 'Shared trip',
    email,
    role: prev?.role || 'editor',
    status: 'revoked',
    invitedByUid: prev?.invitedByUid || user.uid,
    invitedByEmail: prev?.invitedByEmail || user.email,
    invitedAt: prev?.invitedAt || nowIso(),
  }
  const acceptedUid = prev?.acceptedUid || memberUid
  if (acceptedUid) revoked.acceptedUid = acceptedUid

  const uidToRevoke = acceptedUid
  const batch = writeBatch(db)
  batch.set(doc(db, 'trips', tripId, 'invites', key), forFirestore(revoked))
  batch.set(doc(db, 'emailInvites', key, 'trips', tripId), forFirestore(revoked))
  // Delete member doc so a later re-invite can create a fresh active membership
  if (uidToRevoke) {
    batch.delete(doc(db, 'trips', tripId, 'members', uidToRevoke))
  }
  await batch.commit()
}

export async function revokeInvite(trip: TripRecord, rawEmail: string): Promise<void> {
  const user = requireCloudUser()
  if (!trip.cloudTripId) throw new Error('Trip is not shared')
  requireOwner(trip, user)
  const email = normalizeEmail(rawEmail)
  const key = emailDocKey(email)
  if (!key) throw new Error('Invalid email')

  const tripId = trip.cloudTripId
  const inviteSnap = await getDoc(doc(dbOrThrow(), 'trips', tripId, 'invites', key))
  const prev = inviteSnap.exists() ? (inviteSnap.data() as TripInvite) : null

  // Fallback: find active member by email when acceptedUid is missing.
  let memberUid = prev?.acceptedUid
  if (!memberUid) {
    const members = await listTripMembers(tripId)
    memberUid = members.find((m) => normalizeEmail(m.email) === email && m.role !== 'owner')?.uid
  }

  await writeRevokedInvite(trip, email, prev, memberUid)
}

/** Owner revokes an active editor by uid (and matching invite if any). */
export async function revokeMember(trip: TripRecord, memberUid: string): Promise<void> {
  const user = requireCloudUser()
  const db = dbOrThrow()
  if (!trip.cloudTripId) throw new Error('Trip is not shared')
  requireOwner(trip, user)
  if (memberUid === user.uid) throw new Error('Cannot revoke the owner')

  const tripId = trip.cloudTripId
  const memberRef = doc(db, 'trips', tripId, 'members', memberUid)
  const memberSnap = await getDoc(memberRef)
  if (!memberSnap.exists()) throw new Error('Member not found')
  const member = memberSnap.data() as TripMember
  if (member.role === 'owner') throw new Error('Cannot revoke the owner')

  const email = normalizeEmail(member.email)
  const key = emailDocKey(email)
  const inviteSnap = key
    ? await getDoc(doc(db, 'trips', tripId, 'invites', key))
    : null
  const prev = inviteSnap?.exists() ? (inviteSnap.data() as TripInvite) : null

  if (key) {
    await writeRevokedInvite(trip, email, prev, memberUid)
  } else {
    const batch = writeBatch(db)
    batch.delete(memberRef)
    await batch.commit()
  }
}

/** Partner leaves the share; keeps a local unshared copy. */
export async function leaveSharedTrip(trip: TripRecord): Promise<TripRecord> {
  const user = requireCloudUser()
  const db = dbOrThrow()
  if (!trip.cloudTripId) return clearLocalShare(trip)
  if (trip.shareOwnerUid === user.uid) {
    throw new Error('Owners should stop sharing or delete the cloud trip')
  }

  const tripId = trip.cloudTripId
  const memberRef = doc(db, 'trips', tripId, 'members', user.uid)
  const key = emailDocKey(user.email)
  const batch = writeBatch(db)

  const memberSnap = await getDoc(memberRef)
  if (memberSnap.exists()) {
    batch.delete(memberRef)
  }

  if (key) {
    const tripInviteRef = doc(db, 'trips', tripId, 'invites', key)
    const emailInviteRef = doc(db, 'emailInvites', key, 'trips', tripId)
    const prevSnap = await getDoc(emailInviteRef)
    const prev = prevSnap.exists() ? (prevSnap.data() as TripInvite) : null
    const revoked: TripInvite = {
      tripId,
      tripName: trip.meta.name || 'Shared trip',
      email: user.email,
      role: prev?.role || 'editor',
      status: 'revoked',
      invitedByUid: prev?.invitedByUid || trip.shareOwnerUid || user.uid,
      invitedByEmail: prev?.invitedByEmail || trip.shareOwnerEmail || user.email,
      invitedAt: prev?.invitedAt || nowIso(),
      acceptedUid: user.uid,
    }
    batch.set(tripInviteRef, forFirestore(revoked))
    batch.set(emailInviteRef, forFirestore(revoked))
  }

  await batch.commit()
  return clearLocalShare(trip)
}

export async function stopSharing(trip: TripRecord): Promise<TripRecord> {
  const user = requireCloudUser()
  const db = dbOrThrow()
  if (!trip.cloudTripId) return clearLocalShare(trip)
  requireOwner(trip, user)

  const tripId = trip.cloudTripId
  const [invites, members] = await Promise.all([
    listTripInvites(tripId),
    listTripMembers(tripId),
  ])

  for (const inv of invites) {
    if (inv.status === 'pending' || inv.status === 'accepted') {
      await revokeInvite(trip, inv.email)
    }
  }
  for (const m of members) {
    if (m.role !== 'owner' && m.uid !== user.uid) {
      // May already be revoked via invite; ignore failures for missing docs.
      try {
        await revokeMember(trip, m.uid)
      } catch {
        /* already revoked */
      }
    }
  }

  const localStopped = {
    ...trip,
    shareEnabled: false,
    cloudTripId: tripId,
    updatedAt: nowIso(),
  }
  // Keep cloud trip for possible re-enable, but mark record unshared.
  try {
    const remote = await getDoc(doc(db, 'trips', tripId))
    if (remote.exists()) {
      const remoteData = remote.data() as CloudTripDoc
      const recorded = decodeRecordFromFirestore(remoteData.record)
      await updateDoc(
        doc(db, 'trips', tripId),
        forFirestore({
          updatedAt: nowIso(),
          lastWriterUid: user.uid,
          record: encodeRecordForFirestore({
            ...recorded,
            shareEnabled: false,
            cloudTripId: tripId,
          }),
        }),
      )
    }
  } catch {
    /* best-effort cloud flag */
  }

  return localStopped
}

/**
 * Owner cascade-deletes cloud trip + members + invites.
 * Does not touch IndexedDB — caller deletes local separately.
 */
export async function deleteCloudShare(trip: TripRecord): Promise<void> {
  const user = requireCloudUser()
  const db = dbOrThrow()
  if (!trip.cloudTripId) return
  requireOwner(trip, user)

  const tripId = trip.cloudTripId
  const [invites, members] = await Promise.all([
    listAllTripInvites(tripId),
    listAllTripMembers(tripId),
  ])

  // Firestore batches max 500 ops; couple share is tiny.
  const batch = writeBatch(db)
  for (const inv of invites) {
    const key = emailDocKey(normalizeEmail(inv.email))
    if (key) {
      batch.delete(doc(db, 'trips', tripId, 'invites', key))
      batch.delete(doc(db, 'emailInvites', key, 'trips', tripId))
    }
  }
  for (const m of members) {
    batch.delete(doc(db, 'trips', tripId, 'members', m.uid))
  }
  batch.delete(doc(db, 'trips', tripId))
  await batch.commit()
}

export function canManageShare(trip: TripRecord, user: CloudUser | null): boolean {
  if (!user || !isTripShared(trip)) return false
  return Boolean(trip.shareOwnerUid && trip.shareOwnerUid === user.uid)
}
