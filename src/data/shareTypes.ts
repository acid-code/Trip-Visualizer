/** Share / invite types for couple co-planning. */

export type ShareRole = 'owner' | 'editor'
export type InviteStatus = 'pending' | 'active' | 'revoked' | 'accepted'

export type TripInvite = {
  tripId: string
  tripName: string
  email: string
  role: ShareRole
  status: InviteStatus
  invitedByUid: string
  invitedByEmail: string
  invitedAt: string
  acceptedUid?: string
}

export type TripMember = {
  uid: string
  email: string
  role: ShareRole
  status: 'active' | 'revoked'
  joinedAt: string
}

export type CloudTripDoc = {
  ownerUid: string
  ownerEmail: string
  revision: number
  updatedAt: string
  lastWriterUid: string
  /** Encoded TripRecord (routeCoords as {lat,lon}[] for Firestore). */
  record: unknown
}
