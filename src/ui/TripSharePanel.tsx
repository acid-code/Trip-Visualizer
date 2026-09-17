import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TripRecord } from '../domain/types'
import type { CloudUser } from '../data/cloudAuth'
import {
  acceptInvite,
  canManageShare,
  enableTripSharing,
  inviteToTrip,
  isTripShared,
  leaveSharedTrip,
  listMyPendingInvites,
  listTripInvites,
  listTripMembers,
  revokeInvite,
  revokeMember,
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
  onAcceptedTrip?: (trip: TripRecord) => void | Promise<void>
  /** Full management-center layout (Settings → Sharing). */
  management?: boolean
}

export function TripSharePanel({
  trip,
  cloudUser,
  onCloudUser,
  onTripChange,
  onStatus,
  onAcceptedTrip,
  management = false,
}: Props) {
  const configured = isCloudAuthConfigured()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [invites, setInvites] = useState<TripInvite[]>([])
  const [members, setMembers] = useState<TripMember[]>([])
  const [pendingMine, setPendingMine] = useState<TripInvite[]>([])
  const [confirm, setConfirm] = useState<null | {
    title: string
    body: string
    action: () => Promise<void>
  }>(null)

  const shared = isTripShared(trip)
  const owner = canManageShare(trip ?? ({ shareEnabled: false } as TripRecord), cloudUser)
  const isEditor =
    shared && cloudUser && trip?.shareOwnerUid && trip.shareOwnerUid !== cloudUser.uid

  async function refreshLists() {
    if (!cloudUser) {
      setInvites([])
      setMembers([])
      setPendingMine([])
      return
    }
    try {
      setPendingMine(await listMyPendingInvites())
    } catch (err) {
      logClientError('share-list-pending', err)
      setPendingMine([])
      setLocalError(shareErrorMessage(err, 'Could not load invites for your account'))
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
    } catch (err) {
      logClientError('share-list-trip', err)
      setInvites([])
      setMembers([])
    }
  }

  useEffect(() => {
    void refreshLists()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudUser?.uid, trip?.cloudTripId, trip?.shareEnabled])

  useEffect(() => {
    if (!cloudUser) return
    const onVis = () => {
      if (document.visibilityState === 'visible') void refreshLists()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudUser?.uid])

  function runBusy(fn: () => Promise<void>) {
    setBusy(true)
    setLocalError(null)
    void fn()
      .catch((err) => {
        const msg = shareErrorMessage(err, 'Sharing action failed')
        setLocalError(msg)
        onStatus(msg)
      })
      .finally(() => setBusy(false))
  }

  if (!configured) {
    return (
      <div className="settings-card">
        <div className="settings-card-title">Sharing</div>
        <p className="text-[12px] text-[var(--ink-muted)]">
          Couple sharing needs Firebase. Set{' '}
          <code className="rounded bg-white/10 px-1">VITE_FIREBASE_*</code> (see README), enable
          Google Auth + Firestore, then redeploy.
        </p>
      </div>
    )
  }

  const pendingOwned = invites.filter((i) => i.status === 'pending')

  useEffect(() => {
    if (!confirm) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) setConfirm(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, busy])

  const confirmModal =
    confirm && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-end justify-center bg-black/55 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:items-center"
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-confirm-title"
            onMouseDown={(e) => {
              e.stopPropagation()
              if (e.target === e.currentTarget && !busy) setConfirm(null)
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-full max-w-sm overflow-hidden rounded-3xl border border-[var(--glass-border)] bg-[var(--paper)] text-[var(--ink)] shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
              <div className="px-5 pt-5">
                <h2 id="share-confirm-title" className="text-[15px] font-semibold leading-snug">
                  {confirm.title}
                </h2>
                <p className="mt-2 text-sm text-[var(--ink-muted)]">{confirm.body}</p>
              </div>
              <div className="flex gap-2 px-5 py-5">
                <button
                  type="button"
                  className="flex-1 rounded-full border border-[var(--glass-border)] bg-white/60 px-4 py-3 text-sm font-medium text-[var(--ink-muted)] disabled:opacity-50"
                  disabled={busy}
                  onClick={() => setConfirm(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="flex-1 rounded-full bg-rose-600 px-4 py-3 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    const action = confirm.action
                    setConfirm(null)
                    runBusy(action)
                  }}
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <div className="space-y-3">
      {confirmModal}
      {localError ? (
        <p className="rounded-xl border border-rose-300/50 bg-rose-500/10 px-2.5 py-2 text-[12px] text-rose-700 dark:text-rose-200">
          {localError}
        </p>
      ) : null}

      {/* Identity */}
      <section className="settings-card">
        <div className="settings-card-title">Account</div>
        {!cloudUser ? (
          <button
            type="button"
            className="rounded-full bg-[var(--coral)] px-3 py-2 text-sm font-semibold text-white"
            disabled={busy}
            onClick={() =>
              runBusy(async () => {
                const u = await signInWithGoogle()
                onCloudUser(u)
                onStatus(`Signed in as ${u.email}`)
              })
            }
          >
            Sign in with Google
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 text-[12px] text-[var(--ink)]">
              <div className="truncate font-semibold">
                {cloudUser.displayName || cloudUser.email}
              </div>
              <div className="truncate text-[var(--ink-muted)]">{cloudUser.email}</div>
            </div>
            <button
              type="button"
              className="rounded-full border border-[var(--glass-border)] px-3 py-1.5 text-xs"
              disabled={busy}
              onClick={() =>
                runBusy(async () => {
                  await signOutCloud()
                  onCloudUser(null)
                  onStatus('Signed out of sharing')
                })
              }
            >
              Sign out
            </button>
          </div>
        )}
        <p className="mt-2 text-[10px] text-[var(--ink-muted)]">
          Invites must match this Google email exactly. There is no email notification —
          your partner opens Settings → Sharing → Join.
        </p>
      </section>

      {/* Inbox */}
      {cloudUser ? (
        <section className="settings-card">
          <div className="settings-card-title">Inbox</div>
          {pendingMine.length ? (
            <div className="space-y-2">
              {pendingMine.map((inv) => (
                <div
                  key={`${inv.tripId}-${inv.email}`}
                  className="flex items-center justify-between gap-2 rounded-xl border border-[var(--coral)]/40 bg-[var(--coral)]/10 px-2.5 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[var(--ink)]">
                      {inv.tripName}
                    </div>
                    <div className="truncate text-[10px] text-[var(--ink-muted)]">
                      from {inv.invitedByEmail}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded-full bg-[var(--coral)] px-2.5 py-1 text-xs font-semibold text-white"
                    disabled={busy}
                    onClick={() =>
                      runBusy(async () => {
                        const t = await acceptInvite(inv.tripId)
                        await onAcceptedTrip?.(t)
                        onStatus(`Joined “${t.meta.name}”`)
                        await refreshLists()
                      })
                    }
                  >
                    Join
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-[var(--ink-muted)]">
              No pending invites for{' '}
              <span className="font-medium text-[var(--ink)]">{cloudUser.email}</span>.
            </p>
          )}
        </section>
      ) : null}

      {/* This trip */}
      {cloudUser && trip ? (
        <section className="settings-card space-y-2">
          <div className="settings-card-title">This trip</div>
          {!shared ? (
            <>
              <p className="text-[11px] text-[var(--ink-muted)]">
                Not shared. Enable to upload Journey + Plan to the cloud and invite a partner.
              </p>
              <button
                type="button"
                className="w-full rounded-full border border-[var(--glass-border)] px-3 py-2 text-sm font-semibold text-[var(--ink)] disabled:opacity-60"
                disabled={busy}
                onClick={() =>
                  runBusy(async () => {
                    const next = await enableTripSharing(trip)
                    await onTripChange(next)
                    onStatus('Sharing enabled · invite your partner by email')
                    await refreshLists()
                  })
                }
              >
                {busy ? 'Enabling…' : 'Enable sharing'}
              </button>
            </>
          ) : owner ? (
            <>
              <p className="text-[11px] text-[var(--sky)]">
                Shared as owner · near-live · {trip.shareOwnerEmail || cloudUser.email}
              </p>
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
                    const raw = email
                    runBusy(async () => {
                      await inviteToTrip(trip, raw)
                      setEmail('')
                      onStatus(`Invited ${raw.trim().toLowerCase()}`)
                      await refreshLists()
                    })
                  }}
                >
                  Invite
                </button>
              </div>
            </>
          ) : (
            <p className="text-[11px] text-[var(--ink-muted)]">
              Shared as editor · owner {trip.shareOwnerEmail || '—'}. Only the owner can
              invite or revoke.
            </p>
          )}
        </section>
      ) : null}

      {/* People */}
      {cloudUser && trip && shared && (members.length > 0 || pendingOwned.length > 0) ? (
        <section className="settings-card space-y-3">
          <div className="settings-card-title">People</div>
          {members.length ? (
            <ul className="space-y-1">
              {members.map((m) => (
                <li key={m.uid} className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="truncate text-[var(--ink)]">
                    {m.email}
                    {m.role === 'owner' ? ' · owner' : ''}
                  </span>
                  {owner && m.role !== 'owner' ? (
                    <button
                      type="button"
                      className="shrink-0 text-[11px] font-semibold text-rose-500"
                      disabled={busy}
                      onClick={() =>
                        setConfirm({
                          title: `Revoke ${m.email}?`,
                          body: 'They lose cloud access. You can invite them again later.',
                          action: async () => {
                            await revokeMember(trip, m.uid)
                            onStatus(`Revoked ${m.email}`)
                            await refreshLists()
                          },
                        })
                      }
                    >
                      Revoke
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {pendingOwned.length ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                Pending invites
              </div>
              <ul className="space-y-1">
                {pendingOwned.map((i) => (
                  <li
                    key={i.email}
                    className="flex items-center justify-between gap-2 text-[12px]"
                  >
                    <span className="truncate">{i.email}</span>
                    {owner ? (
                      <button
                        type="button"
                        className="text-[11px] font-semibold text-rose-500"
                        disabled={busy}
                        onClick={() =>
                          setConfirm({
                            title: `Cancel invite to ${i.email}?`,
                            body: 'They will no longer see this trip in their inbox.',
                            action: async () => {
                              await revokeInvite(trip, i.email)
                              onStatus(`Revoked ${i.email}`)
                              await refreshLists()
                            },
                          })
                        }
                      >
                        Revoke
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Danger */}
      {cloudUser && trip && shared ? (
        <section className="settings-card space-y-2">
          <div className="settings-card-title">Access</div>
          {owner ? (
            <>
              <button
                type="button"
                className="text-[12px] font-semibold text-rose-600 underline"
                disabled={busy}
                onClick={() =>
                  setConfirm({
                    title: 'Stop sharing?',
                    body: 'Revokes partner access but keeps the cloud trip so you can re-enable later. Delete the trip to wipe the cloud copy.',
                    action: async () => {
                      const next = await stopSharing(trip)
                      await onTripChange(next)
                      onStatus('Sharing stopped — partner access revoked')
                      await refreshLists()
                    },
                  })
                }
              >
                Stop sharing (keep cloud)
              </button>
              <p className="text-[10px] text-[var(--ink-muted)]">
                To delete the cloud copy for everyone, delete the trip from the trip switcher.
              </p>
            </>
          ) : isEditor ? (
            <button
              type="button"
              className="text-[12px] font-semibold text-rose-600 underline"
              disabled={busy}
              onClick={() =>
                setConfirm({
                  title: 'Leave shared trip?',
                  body: 'You keep a local copy. The owner can invite you again later.',
                  action: async () => {
                    const next = await leaveSharedTrip(trip)
                    await onTripChange(next)
                    onStatus('Left shared trip — kept on this device only')
                    await refreshLists()
                  },
                })
              }
            >
              Leave shared trip
            </button>
          ) : null}
        </section>
      ) : null}

      {management ? (
        <p className="px-1 text-[10px] text-[var(--ink-muted)]">
          Project{' '}
          <code className="rounded bg-white/10 px-1">
            {String(import.meta.env.VITE_FIREBASE_PROJECT_ID || '…')}
          </code>
          . After rules changes: Firebase → Firestore → Rules → Publish.
        </p>
      ) : null}
    </div>
  )
}
