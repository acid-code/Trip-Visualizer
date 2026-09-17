import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createId, nowIso } from './db'
import { sanitizeTripRecord, type TripRecord } from '../domain/types'
import type { CloudUser } from './cloudAuth'
import type { CloudTripDoc, TripInvite, TripMember } from './shareTypes'

const owner: CloudUser = {
  uid: 'owner-uid',
  email: 'owner@gmail.com',
  displayName: 'Owner',
  photoURL: '',
  emailVerified: true,
}

const partner: CloudUser = {
  uid: 'partner-uid',
  email: 'partner@gmail.com',
  displayName: 'Partner',
  photoURL: '',
  emailVerified: true,
}

let currentUser: CloudUser = owner

type MockFn = (...args: unknown[]) => unknown
const setDocMock = vi.fn<MockFn>(async () => undefined)
const getDocMock = vi.fn<MockFn>()
const getDocsMock = vi.fn<MockFn>()
const updateDocMock = vi.fn<MockFn>(async () => undefined)
const onSnapshotMock = vi.fn<MockFn>()
const batchSetMock = vi.fn<MockFn>()
const batchCommitMock = vi.fn<MockFn>(async () => undefined)

vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...segments: string[]) => ({
    id: segments[segments.length - 1],
    path: segments.join('/'),
    segments,
  }),
  collection: (_db: unknown, ...segments: string[]) => ({
    path: segments.join('/'),
    segments,
  }),
  setDoc: (...args: unknown[]) => setDocMock(...args),
  getDoc: (...args: unknown[]) => getDocMock(...args),
  getDocs: (...args: unknown[]) => getDocsMock(...args),
  updateDoc: (...args: unknown[]) => updateDocMock(...args),
  onSnapshot: (...args: unknown[]) => onSnapshotMock(...args),
  writeBatch: () => ({
    set: (...args: unknown[]) => batchSetMock(...args),
    commit: (...args: unknown[]) => batchCommitMock(...args),
  }),
}))

vi.mock('./cloudAuth', () => ({
  requireCloudUser: () => currentUser,
}))

vi.mock('./firebaseApp', () => ({
  getFirestoreDb: vi.fn(() => ({ __fake: true })),
}))

import {
  acceptInvite,
  canManageShare,
  decodeRecordFromFirestore,
  enableTripSharing,
  encodeRecordForFirestore,
  inviteToTrip,
  isTripShared,
  listMyPendingInvites,
  listTripInvites,
  listTripMembers,
  pullSharedTrip,
  pushSharedTrip,
  revokeInvite,
  stopSharing,
  tripRecordForCloud,
  watchSharedTrip,
} from './cloudSync'

function sampleTrip(overrides: Partial<TripRecord> = {}): TripRecord {
  const stamp = nowIso()
  const sectionId = createId('SEC')
  const itemId = createId('S')
  const base = sanitizeTripRecord({
    id: createId('TRIP'),
    meta: {
      name: 'Couple trip',
      startDate: '2026-09-17',
      endDate: '2026-09-20',
      homeCurrency: 'EUR',
      timezoneNote: 'All times are local',
      travelers: '2',
      notes: 'secret notes',
    },
    items: [
      {
        id: itemId,
        type: 'drive',
        title: 'Drive',
        place: '',
        city: 'Paris',
        date: '2026-09-17',
        endDate: '',
        start: '10:00',
        end: '',
        from: 'A',
        to: 'B',
        notes: '',
        confirm: 'CONF',
        cost: null,
        currency: 'EUR',
        lat: 48.86,
        lon: 2.34,
        latTo: 48.87,
        lonTo: 2.35,
        url: '',
        googleMapsUri: '',
        osmId: '',
        tags: [],
        status: 'planned',
        source: 'app',
        updatedAt: stamp,
        routeCoords: [
          [48.86, 2.34],
          [48.87, 2.35],
        ],
      },
    ],
    planSections: [
      {
        id: sectionId,
        title: 'Must see',
        color: '#f97316',
        icon: '📍',
        order: 0,
      },
    ],
    planPlaces: [
      {
        id: createId('PP'),
        sectionId,
        name: 'Louvre',
        place: 'Louvre',
        city: 'Paris',
        notes: 'Go early',
        lat: 48.86,
        lon: 2.34,
        url: '',
        googleMapsUri: '',
        osmId: '',
        scheduledDay: '2026-09-18',
        dayOrder: 1,
        linkedItemId: itemId,
      },
    ],
    isExample: false,
    createdAt: stamp,
    updatedAt: stamp,
  })
  return { ...base, ...overrides }
}

function snapExists(data: unknown) {
  return {
    exists: () => true,
    data: () => data,
  }
}

function snapMissing() {
  return {
    exists: () => false,
    data: () => undefined,
  }
}

function docsSnap(rows: unknown[]) {
  return {
    docs: rows.map((data, i) => ({
      id: `doc-${i}`,
      data: () => data,
    })),
  }
}

beforeEach(() => {
  currentUser = owner
  setDocMock.mockReset().mockResolvedValue(undefined)
  getDocMock.mockReset()
  getDocsMock.mockReset()
  updateDocMock.mockReset().mockResolvedValue(undefined)
  onSnapshotMock.mockReset()
  batchSetMock.mockReset()
  batchCommitMock.mockReset().mockResolvedValue(undefined)
})

describe('isTripShared / canManageShare / tripRecordForCloud', () => {
  it('detects shared trips', () => {
    expect(isTripShared(null)).toBe(false)
    expect(isTripShared(sampleTrip())).toBe(false)
    expect(
      isTripShared(sampleTrip({ cloudTripId: 'T1', shareEnabled: true })),
    ).toBe(true)
    expect(
      isTripShared(sampleTrip({ cloudTripId: 'T1', shareEnabled: false })),
    ).toBe(false)
  })

  it('canManageShare only for owner of a shared trip', () => {
    const shared = sampleTrip({
      cloudTripId: 'T1',
      shareEnabled: true,
      shareOwnerUid: owner.uid,
    })
    expect(canManageShare(shared, null)).toBe(false)
    expect(canManageShare(sampleTrip(), owner)).toBe(false)
    expect(canManageShare(shared, owner)).toBe(true)
    expect(canManageShare(shared, partner)).toBe(false)
    expect(
      canManageShare(
        sampleTrip({ cloudTripId: 'T1', shareEnabled: true, shareOwnerUid: '' }),
        partner,
      ),
    ).toBe(true)
  })

  it('tripRecordForCloud fills cloudTripId and revision', () => {
    const trip = sampleTrip({ revision: undefined, cloudTripId: '' })
    const cloud = tripRecordForCloud(trip)
    expect(cloud.cloudTripId).toBe(trip.id)
    expect(cloud.revision).toBe(0)
  })
})

describe('encodeRecordForFirestore / decodeRecordFromFirestore', () => {
  it('round-trips Journey + Plan and converts nested routeCoords', () => {
    const trip = sampleTrip({
      cloudTripId: 'TRIPX',
      shareEnabled: true,
      revision: 3,
    })
    const encoded = encodeRecordForFirestore(trip) as {
      items: Array<{ routeCoords: Array<{ lat: number; lon: number }> }>
      planPlaces: Array<{ name: string; dayOrder: number | null }>
      planSections: unknown[]
    }
    expect(Array.isArray(encoded.items[0]?.routeCoords)).toBe(true)
    expect(encoded.items[0]?.routeCoords[0]).toEqual({ lat: 48.86, lon: 2.34 })
    expect(JSON.stringify(encoded).includes('[[')).toBe(false)
    expect(encoded.planSections).toHaveLength(1)
    expect(encoded.planPlaces[0]?.name).toBe('Louvre')
    expect(encoded.planPlaces[0]?.dayOrder).toBe(1)

    const decoded = decodeRecordFromFirestore(encoded)
    expect(decoded.items[0]?.routeCoords?.[0]).toEqual([48.86, 2.34])
    expect(decoded.planPlaces[0]?.name).toBe('Louvre')
    expect(decoded.planPlaces[0]?.dayOrder).toBe(1)
    expect(decoded.meta.notes).toBe('secret notes')
  })

  it('accepts legacy tuple routeCoords on decode', () => {
    const trip = sampleTrip()
    const raw = {
      ...trip,
      items: [
        {
          ...trip.items[0],
          routeCoords: [
            [1, 2],
            [3, 4],
          ],
        },
      ],
    }
    const decoded = decodeRecordFromFirestore(raw)
    expect(decoded.items[0]?.routeCoords).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('drops invalid coordinate points', () => {
    const trip = sampleTrip()
    const decoded = decodeRecordFromFirestore({
      ...trip,
      items: [
        {
          ...trip.items[0],
          routeCoords: [{ lat: 'x', lon: 1 }, { lat: 2, lon: 3 }],
        },
      ],
    })
    expect(decoded.items[0]?.routeCoords).toEqual([[2, 3]])
  })
})

describe('enableTripSharing', () => {
  it('writes trip then owner member and returns shared record', async () => {
    const trip = sampleTrip({ revision: 1 })
    const next = await enableTripSharing(trip)
    expect(next.shareEnabled).toBe(true)
    expect(next.cloudTripId).toBe(trip.id)
    expect(next.shareOwnerUid).toBe(owner.uid)
    expect(next.shareOwnerEmail).toBe(owner.email)
    expect(next.revision).toBe(2)
    expect(setDocMock).toHaveBeenCalledTimes(2)
    const firstPayload = setDocMock.mock.calls[0]![1] as CloudTripDoc
    expect(firstPayload.ownerUid).toBe(owner.uid)
    expect(firstPayload.revision).toBe(2)
    const encoded = firstPayload.record as {
      items: Array<{ routeCoords: Array<{ lat: number; lon: number }> }>
    }
    expect(encoded.items[0]?.routeCoords[0]).toEqual({ lat: 48.86, lon: 2.34 })
    const memberPayload = setDocMock.mock.calls[1]![1] as TripMember
    expect(memberPayload).toMatchObject({
      uid: owner.uid,
      role: 'owner',
      status: 'active',
    })
  })

  it('wraps Firestore errors with a friendly message', async () => {
    setDocMock.mockRejectedValueOnce({ code: 'permission-denied', message: 'no' })
    await expect(enableTripSharing(sampleTrip())).rejects.toThrow(/Permission denied/)
  })

  it('throws when Firebase is not configured', async () => {
    const { getFirestoreDb } = await import('./firebaseApp')
    vi.mocked(getFirestoreDb).mockReturnValueOnce(null)
    await expect(enableTripSharing(sampleTrip())).rejects.toThrow(/not configured/)
  })
})

describe('pushSharedTrip', () => {
  it('rejects unshared trips', async () => {
    await expect(pushSharedTrip(sampleTrip())).rejects.toThrow(/not shared/)
  })

  it('rejects missing remote docs', async () => {
    getDocMock.mockResolvedValueOnce(snapMissing())
    await expect(
      pushSharedTrip(sampleTrip({ cloudTripId: 'T1', shareEnabled: true })),
    ).rejects.toThrow(/not found/)
  })

  it('throws PARTNER_UPDATED when remote revision is ahead from another writer', async () => {
    const local = sampleTrip({
      cloudTripId: 'T1',
      shareEnabled: true,
      revision: 1,
    })
    const remoteRecord = encodeRecordForFirestore({
      ...local,
      meta: { ...local.meta, name: 'Partner edit' },
      revision: 5,
    })
    getDocMock.mockResolvedValueOnce(
      snapExists({
        ownerUid: owner.uid,
        ownerEmail: owner.email,
        revision: 5,
        updatedAt: nowIso(),
        lastWriterUid: partner.uid,
        record: remoteRecord,
      } satisfies CloudTripDoc),
    )
    await expect(
      pushSharedTrip(local, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ message: 'PARTNER_UPDATED' })
  })

  it('pushes when expected revision matches or writer is self', async () => {
    const local = sampleTrip({
      cloudTripId: 'T1',
      shareEnabled: true,
      revision: 2,
      shareOwnerUid: owner.uid,
      shareOwnerEmail: owner.email,
    })
    getDocMock.mockResolvedValueOnce(
      snapExists({
        ownerUid: owner.uid,
        ownerEmail: owner.email,
        revision: 2,
        updatedAt: nowIso(),
        lastWriterUid: owner.uid,
        record: encodeRecordForFirestore(local),
      } satisfies CloudTripDoc),
    )
    const next = await pushSharedTrip(local, { expectedRevision: 2 })
    expect(next.revision).toBe(3)
    expect(setDocMock).toHaveBeenCalledTimes(1)
    const payload = setDocMock.mock.calls[0]![1] as CloudTripDoc
    expect(payload.lastWriterUid).toBe(owner.uid)
    expect(payload.revision).toBe(3)
  })
})

describe('pullSharedTrip / watchSharedTrip', () => {
  it('pulls and decodes a remote trip', async () => {
    const trip = sampleTrip({ cloudTripId: 'T1', shareEnabled: true, revision: 4 })
    getDocMock.mockResolvedValueOnce(
      snapExists({
        ownerUid: owner.uid,
        ownerEmail: owner.email,
        revision: 4,
        updatedAt: nowIso(),
        lastWriterUid: owner.uid,
        record: encodeRecordForFirestore(trip),
      } satisfies CloudTripDoc),
    )
    const pulled = await pullSharedTrip('T1')
    expect(pulled?.meta.name).toBe('Couple trip')
    expect(pulled?.planPlaces[0]?.dayOrder).toBe(1)
    expect(pulled?.items[0]?.routeCoords?.[0]).toEqual([48.86, 2.34])
  })

  it('returns null when trip is missing', async () => {
    getDocMock.mockResolvedValueOnce(snapMissing())
    expect(await pullSharedTrip('missing')).toBeNull()
  })

  it('watchSharedTrip forwards decoded trips and errors', () => {
    const onTrip = vi.fn()
    const onError = vi.fn()
    type Snap = { exists: () => boolean; data: () => unknown }
    const handlers: {
      next: ((snap: Snap) => void) | undefined
      err: ((err: Error) => void) | undefined
    } = { next: undefined, err: undefined }
    onSnapshotMock.mockImplementation((...args: unknown[]) => {
      handlers.next = args[1] as (snap: Snap) => void
      handlers.err = args[2] as (err: Error) => void
      return vi.fn()
    })
    const unsub = watchSharedTrip('T1', onTrip, onError)
    expect(typeof unsub).toBe('function')

    const trip = sampleTrip({ cloudTripId: 'T1', shareEnabled: true })
    handlers.next?.(
      snapExists({
        ownerUid: owner.uid,
        ownerEmail: owner.email,
        revision: 1,
        updatedAt: nowIso(),
        lastWriterUid: owner.uid,
        record: encodeRecordForFirestore(trip),
      } satisfies CloudTripDoc),
    )
    expect(onTrip).toHaveBeenCalled()
    const firstTrip = onTrip.mock.calls[0]![0] as TripRecord
    expect(firstTrip.planPlaces[0]?.name).toBe('Louvre')

    handlers.next?.(snapMissing())
    expect(onTrip).toHaveBeenCalledTimes(1)

    handlers.next?.(
      snapExists({
        ownerUid: owner.uid,
        ownerEmail: owner.email,
        revision: 1,
        updatedAt: nowIso(),
        lastWriterUid: owner.uid,
        record: { not: 'a trip' },
      }),
    )
    expect(onError).toHaveBeenCalled()

    handlers.err?.(new Error('network'))
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })
})

describe('invite / list / accept / revoke / stop', () => {
  it('inviteToTrip validates ownership and email', async () => {
    await expect(inviteToTrip(sampleTrip(), 'a@b.com')).rejects.toThrow(/Enable sharing/)
    const shared = sampleTrip({
      cloudTripId: 'T1',
      shareEnabled: true,
      shareOwnerUid: owner.uid,
    })
    await expect(inviteToTrip(shared, 'not-email')).rejects.toThrow(/valid email/)
    await expect(inviteToTrip(shared, owner.email)).rejects.toThrow(/already own/)
    currentUser = partner
    await expect(inviteToTrip(shared, 'x@y.com')).rejects.toThrow(/Only the trip owner/)
  })

  it('inviteToTrip writes invite docs for owner', async () => {
    currentUser = owner
    const shared = sampleTrip({
      cloudTripId: 'T1',
      shareEnabled: true,
      shareOwnerUid: owner.uid,
      meta: { ...sampleTrip().meta, name: 'Our trip' },
    })
    const invite = await inviteToTrip(shared, ' Partner@Gmail.COM ')
    expect(invite.email).toBe('partner@gmail.com')
    expect(invite.status).toBe('pending')
    expect(invite.tripName).toBe('Our trip')
    expect(batchSetMock).toHaveBeenCalledTimes(2)
    expect(batchCommitMock).toHaveBeenCalledTimes(1)
  })

  it('lists invites and members with status filters', async () => {
    getDocsMock.mockResolvedValueOnce(
      docsSnap([
        { email: 'a@x.com', status: 'pending' },
        { email: 'b@x.com', status: 'accepted' },
        { email: 'c@x.com', status: 'revoked' },
      ]),
    )
    const invites = await listTripInvites('T1')
    expect(invites.map((i) => i.email)).toEqual(['a@x.com', 'b@x.com'])

    getDocsMock.mockResolvedValueOnce(
      docsSnap([
        { uid: '1', email: 'a@x.com', status: 'active', role: 'owner' },
        { uid: '2', email: 'b@x.com', status: 'revoked', role: 'editor' },
      ]),
    )
    const members = await listTripMembers('T1')
    expect(members).toHaveLength(1)
    expect(members[0]?.uid).toBe('1')
  })

  it('listMyPendingInvites filters to current user pending', async () => {
    currentUser = partner
    getDocsMock.mockResolvedValueOnce(
      docsSnap([
        {
          tripId: 'T1',
          email: 'partner@gmail.com',
          status: 'pending',
        },
        {
          tripId: 'T2',
          email: 'other@gmail.com',
          status: 'pending',
        },
        {
          tripId: 'T3',
          email: 'partner@gmail.com',
          status: 'accepted',
        },
      ]),
    )
    const pending = await listMyPendingInvites()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.tripId).toBe('T1')
  })

  it('acceptInvite creates member and returns shared trip', async () => {
    currentUser = partner
    const trip = sampleTrip({ id: 'T1', cloudTripId: 'T1', shareEnabled: true })
    const invite: TripInvite = {
      tripId: 'T1',
      tripName: 'Our trip',
      email: partner.email,
      role: 'editor',
      status: 'pending',
      invitedByUid: owner.uid,
      invitedByEmail: owner.email,
      invitedAt: nowIso(),
    }
    getDocMock
      .mockResolvedValueOnce(snapExists(invite))
      .mockResolvedValueOnce(
        snapExists({
          ownerUid: owner.uid,
          ownerEmail: owner.email,
          revision: 1,
          updatedAt: nowIso(),
          lastWriterUid: owner.uid,
          record: encodeRecordForFirestore(trip),
        } satisfies CloudTripDoc),
      )
    const joined = await acceptInvite('T1')
    expect(joined.shareEnabled).toBe(true)
    expect(joined.cloudTripId).toBe('T1')
    expect(batchSetMock).toHaveBeenCalledTimes(3)
    expect(batchCommitMock).toHaveBeenCalled()
  })

  it('acceptInvite rejects revoked / wrong email / missing', async () => {
    currentUser = partner
    getDocMock.mockResolvedValueOnce(snapMissing())
    await expect(acceptInvite('T1')).rejects.toThrow(/Invite not found/)

    getDocMock.mockResolvedValueOnce(
      snapExists({
        tripId: 'T1',
        tripName: 'x',
        email: 'other@gmail.com',
        role: 'editor',
        status: 'pending',
        invitedByUid: owner.uid,
        invitedByEmail: owner.email,
        invitedAt: nowIso(),
      } satisfies TripInvite),
    )
    await expect(acceptInvite('T1')).rejects.toThrow(/different email/)

    getDocMock.mockResolvedValueOnce(
      snapExists({
        tripId: 'T1',
        tripName: 'x',
        email: partner.email,
        role: 'editor',
        status: 'revoked',
        invitedByUid: owner.uid,
        invitedByEmail: owner.email,
        invitedAt: nowIso(),
      } satisfies TripInvite),
    )
    await expect(acceptInvite('T1')).rejects.toThrow(/revoked/)
  })

  it('revokeInvite marks invite and member revoked', async () => {
    currentUser = owner
    const shared = sampleTrip({
      cloudTripId: 'T1',
      shareEnabled: true,
      shareOwnerUid: owner.uid,
    })
    getDocMock.mockResolvedValueOnce(
      snapExists({
        tripId: 'T1',
        tripName: 'Our trip',
        email: partner.email,
        role: 'editor',
        status: 'accepted',
        invitedByUid: owner.uid,
        invitedByEmail: owner.email,
        invitedAt: nowIso(),
        acceptedUid: partner.uid,
      } satisfies TripInvite),
    )
    await revokeInvite(shared, partner.email)
    expect(batchSetMock).toHaveBeenCalled()
    expect(batchCommitMock).toHaveBeenCalled()
    const payloads = batchSetMock.mock.calls.map((c) => c[1] as { status?: string })
    expect(payloads.some((p) => p.status === 'revoked')).toBe(true)
  })

  it('stopSharing revokes open invites and clears local share flag', async () => {
    currentUser = owner
    const shared = sampleTrip({
      cloudTripId: 'T1',
      shareEnabled: true,
      shareOwnerUid: owner.uid,
    })
    getDocsMock.mockResolvedValueOnce(
      docsSnap([
        {
          tripId: 'T1',
          tripName: 'Our trip',
          email: partner.email,
          role: 'editor',
          status: 'pending',
          invitedByUid: owner.uid,
          invitedByEmail: owner.email,
          invitedAt: nowIso(),
        } satisfies TripInvite,
      ]),
    )
    getDocMock.mockResolvedValue(snapExists({
      tripId: 'T1',
      tripName: 'Our trip',
      email: partner.email,
      role: 'editor',
      status: 'pending',
      invitedByUid: owner.uid,
      invitedByEmail: owner.email,
      invitedAt: nowIso(),
    } satisfies TripInvite))
    const next = await stopSharing(shared)
    expect(next.shareEnabled).toBe(false)
    expect(next.cloudTripId).toBe('T1')
    expect(updateDocMock).toHaveBeenCalled()
  })

  it('stopSharing on unshared trip is a no-op clear', async () => {
    const next = await stopSharing(sampleTrip({ cloudTripId: '' }))
    expect(next.shareEnabled).toBe(false)
    expect(updateDocMock).not.toHaveBeenCalled()
  })
})
