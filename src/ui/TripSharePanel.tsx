import { useEffect, useState } from 'react'
import type { TripRecord } from '../domain/types'
import type { CloudUser } from '../data/cloudAuth'
import {
  acceptInvite,
  canManageShare,
  enableTripSharing,
  inviteToTrip,
  isTripShared,
  listMyPendingInvites,
  listTripInvites,
  listTripMembers,
  revokeInvite,
  shareErrorMessage,
  stopSharing,
} from '../data/cloudSync'
import type { TripInvite, TripMember } from '../data/shareTypes'
import { isCloudAuthConfigured, signInWithGoogle, signOutCloud } from '../data/cloudAuth'
import { logClientError } from '../data/security'

type Props = {
  trip: TripRecord | null
  cloudUser: CloudUser | null
  onCloudUser: (user: CloudUser | null) => void
  onTripChange: (trip: TripRecord) => void | Promise<void>
  onStatus: (msg: string) => void
  /** Called after accepting an invite so App can select/save the trip. */
  onAcceptedTrip?: (trip: TripRecord) => void | Promise<void>
}

export function TripSharePanel({
  trip,
  cloudUser,
  onCloudUser,
  onTripChange,
  onStatus,
  onAcceptedTrip,
}: Props) {
  const configured = isCloudAuthConfigured()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [invites, setInvites] = useState<TripInvite[]>([])
  const [members, setMembers] = useState<TripMember[]>([])
  const [pendingMine, setPendingMine] = useState<TripInvite[]>([])

  const shared = isTripShared(trip)
  const owner = canManageShare(trip ?? ({ shareEnabled: false } as TripRecord), cloudUser)

  async function refreshLists() {
    if (!cloudUser) {
      setInvites([])
      setMembers([])
      setPendingMine([])
      return
    }
    try {
      setPendingMine(await listMyPendingInvites())
    } catch {
      setPendingMine([])
    }
    if (!trip?.cloudTripId || !shared) {
      setInvites([])
      setMembers([])
      return
    }
    try {
      const [inv, mem] = await Promise.all([
        listTripInvites(trip.cloudTripId),
        listTripMembers(trip.cloudTripId),
      ])
      setInvites(inv)
      setMembers(mem)
    } catch {
      setInvites([])
      setMembers([])
    }
  }

  useEffect(() => {
    void refreshLists()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudUser?.uid, trip?.cloudTripId, trip?.shareEnabled])

  if (!configured) {
    return (
      <div className="settings-card">
        <div className="settings-card-title">Share trip</div>
        <p className="text-[12px] text-[var(--ink-muted)]">
          Couple sharing needs Firebase. Set <code className="rounded bg-white/10 px-1">VITE_FIREBASE_*</code>{' '}
          (see README), enable Google Auth + Firestore, then redeploy.
        </p>
      </div>
    )
  }

  return (
    <div className="settings-card">
      <div className="settings-card-title">Share trip</div>
      <p className="mb-2 text-[11px] text-[var(--ink-muted)]">
        Invite by email. Partner must sign in with that Google account. Syncs Journey + Plan
        (lists, days, POIs). No public links.
      </p>
      {localError ? (
        <p className="mb-2 rounded-xl border border-rose-300/50 bg-rose-500/10 px-2.5 py-2 text-[12px] text-rose-700 dark:text-rose-200">
          {localError}
        </p>
      ) : null}

      {!cloudUser ? (
        <button
          type="button"
          className="rounded-full bg-[var(--coral)] px-3 py-2 text-sm font-semibold text-white"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setLocalError(null)
            void signInWithGoogle()
              .then((u) => {
                onCloudUser(u)
                onStatus(`Signed in as ${u.email}`)
              })
              .catch((err) => {
                logClientError('share-signin', err)
                const msg = shareErrorMessage(err, 'Google sign-in failed')
                setLocalError(msg)
                onStatus(msg)
              })
              .finally(() => setBusy(false))
          }}
        >
          Sign in with Google
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 text-[12px] text-[var(--ink)]">
            <div className="truncate font-semibold">{cloudUser.displayName || cloudUser.email}</div>
            <div className="truncate text-[var(--ink-muted)]">{cloudUser.email}</div>
          </div>
          <button
            type="button"
            className="rounded-full border border-[var(--glass-border)] px-3 py-1.5 text-xs"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void signOutCloud()
                .then(() => {
                  onCloudUser(null)
                  onStatus('Signed out of sharing')
                })
                .finally(() => setBusy(false))
            }}
          >
            Sign out
          </button>
        </div>
      )}

      {cloudUser && pendingMine.length ? (
        <div className="mt-3 space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
            Invites for you
          </div>
          {pendingMine.map((inv) => (
            <div
              key={`${inv.tripId}-${inv.email}`}
              className="flex items-center justify-between gap-2 rounded-xl border border-[var(--glass-border)] bg-[var(--paper)] px-2.5 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-[var(--ink)]">{inv.tripName}</div>
                <div className="truncate text-[10px] text-[var(--ink-muted)]">
                  from {inv.invitedByEmail}
                </div>
              </div>
              <button
                type="button"
                className="shrink-0 rounded-full bg-[var(--sky)] px-2.5 py-1 text-xs font-semibold text-white"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void acceptInvite(inv.tripId)
                    .then(async (t) => {
                      await onAcceptedTrip?.(t)
                      onStatus(`Joined “${t.meta.name}”`)
                      await refreshLists()
                    })
                    .catch((err) => {
                      logClientError('share-accept', err)
                      const msg = shareErrorMessage(err, 'Could not accept invite')
                      setLocalError(msg)
                      onStatus(msg)
                    })
                    .finally(() => setBusy(false))
                }}
              >
                Join
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {cloudUser && trip ? (
        <div className="mt-3 space-y-2 border-t border-[var(--glass-border)] pt-3">
          {!shared ? (
            <button
              type="button"
              className="w-full rounded-full border border-[var(--glass-border)] px-3 py-2 text-sm font-semibold text-[var(--ink)] disabled:opacity-60"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                setLocalError(null)
                void enableTripSharing(trip)
                  .then(async (next) => {
                    await onTripChange(next)
                    onStatus('Sharing enabled · invite your partner by email')
                    await refreshLists()
                  })
                  .catch((err) => {
                    logClientError('share-enable', err)
                    const msg = shareErrorMessage(err, 'Could not enable sharing')
                    setLocalError(msg)
                    onStatus(msg)
                  })
                  .finally(() => setBusy(false))
              }}
            >
              {busy ? 'Enabling…' : 'Enable sharing on this trip'}
            </button>
          ) : (
            <>
              <p className="text-[11px] text-[var(--sky)]">
                Shared · near-live · {trip.shareOwnerEmail || 'owner'}
              </p>
              {owner ? (
                <>
                  <div className="flex gap-1.5">
                    <input
                      type="email"
                      className="min-w-0 flex-1 rounded-xl border border-[var(--glass-border)] bg-[var(--paper)] px-2 py-1.5 text-sm"
                      placeholder="partner@gmail.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                    <button
                      type="button"
                      className="rounded-full bg-[var(--coral)] px-3 py-1.5 text-xs font-semibold text-white"
                      disabled={busy || !email.trim()}
                      onClick={() => {
                        setBusy(true)
                        void inviteToTrip(trip, email)
                          .then(async () => {
                            setEmail('')
                            onStatus(`Invited ${email.trim().toLowerCase()}`)
                            await refreshLists()
                          })
                          .catch((err) => {
                            logClientError('share-invite', err)
                            const msg = shareErrorMessage(err, 'Could not send invite')
                            setLocalError(msg)
                            onStatus(msg)
                          })
                          .finally(() => setBusy(false))
                      }}
                    >
                      Invite
                    </button>
                  </div>
                  <button
                    type="button"
                    className="text-[11px] text-[var(--ink-muted)] underline"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true)
                      void stopSharing(trip)
                        .then(async (next) => {
                          await onTripChange(next)
                          onStatus('Sharing stopped for new invites (existing access revoked)')
                          await refreshLists()
                        })
                        .catch((err) => {
                          logClientError('share-stop', err)
                          const msg = shareErrorMessage(err, 'Could not stop sharing')
                          setLocalError(msg)
                          onStatus(msg)
                        })
                        .finally(() => setBusy(false))
                    }}
                  >
                    Stop sharing / revoke invites
                  </button>
                </>
              ) : (
                <p className="text-[11px] text-[var(--ink-muted)]">
                  You are an editor on this trip. Only the owner can invite or revoke.
                </p>
              )}

              {members.length ? (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                    Members
                  </div>
                  <ul className="mt-1 space-y-1">
                    {members.map((m) => (
                      <li key={m.uid} className="flex justify-between gap-2 text-[12px]">
                        <span className="truncate text-[var(--ink)]">
                          {m.email}
                          {m.role === 'owner' ? ' · owner' : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {invites.filter((i) => i.status === 'pending').length ? (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                    Pending invites
                  </div>
                  <ul className="mt-1 space-y-1">
                    {invites
                      .filter((i) => i.status === 'pending')
                      .map((i) => (
                        <li
                          key={i.email}
                          className="flex items-center justify-between gap-2 text-[12px]"
                        >
                          <span className="truncate">{i.email}</span>
                          {owner ? (
                            <button
                              type="button"
                              className="text-[11px] text-rose-500"
                              disabled={busy}
                              onClick={() => {
                                setBusy(true)
                                void revokeInvite(trip, i.email)
                                  .then(async () => {
                                    onStatus(`Revoked ${i.email}`)
                                    await refreshLists()
                                  })
                                  .catch((err) => {
                                    logClientError('share-revoke', err)
                                    const msg = shareErrorMessage(err, 'Could not revoke')
                                    setLocalError(msg)
                                    onStatus(msg)
                                  })
                                  .finally(() => setBusy(false))
                              }}
                            >
                              Revoke
                            </button>
                          ) : null}
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

        <p className="mt-3 text-[10px] text-[var(--ink-muted)]">
          Drive Excel export is a personal backup and may include notes/confirmations — prefer
          shared sync for the couple workspace.
        </p>
        <p className="mt-1 text-[10px] text-[var(--ink-muted)]">
          First-time setup: Firebase Console → Firestore → Rules → paste{' '}
          <code className="rounded bg-white/10 px-1">firestore.rules</code> from the repo →
          Publish. Project:{' '}
          <code className="rounded bg-white/10 px-1">
            {String(import.meta.env.VITE_FIREBASE_PROJECT_ID || '…')}
          </code>
        </p>
    </div>
  )
}
