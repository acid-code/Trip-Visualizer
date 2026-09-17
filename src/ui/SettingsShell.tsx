import { useState, type ReactNode } from 'react'
import type { TripRecord } from '../domain/types'
import type { CloudUser } from '../data/cloudAuth'
import type { ColorMode } from '../data/theme'
import type { WalkAppPref } from '../data/mapsLinks'
import type { DriveFileInfo } from '../data/googleDrive'
import { ITEM_TYPES } from '../domain/types'
import { normalizeCurrency } from '../data/fx'
import { setSetting } from '../data/db'
import { sanitizeSecretInput } from '../data/security'
import { SegmentedControl } from './primitives'
import { TripSharePanel } from './TripSharePanel'
import { TOUCH_SCROLL_Y } from './scrollGesture'

export type SettingsSectionId =
  | 'trip'
  | 'sharing'
  | 'appearance'
  | 'data'
  | 'map'
  | 'tools'

const SECTIONS: Array<{
  id: SettingsSectionId
  title: string
  blurb: string
}> = [
  { id: 'sharing', title: 'Sharing', blurb: 'Invite partner · Join · manage access' },
  { id: 'trip', title: 'This trip', blurb: 'Name, dates, currency, notes' },
  { id: 'appearance', title: 'Appearance', blurb: 'Cream or dark shell' },
  { id: 'data', title: 'Data & Drive', blurb: 'Excel import / export · Google Drive' },
  { id: 'map', title: 'Map & keys', blurb: 'Walk app · Maps · Cesium' },
  { id: 'tools', title: 'Tools & logs', blurb: 'Tips, example trip, client logs' },
]

export type SettingsShellProps = {
  active: TripRecord | null
  cloudUser: CloudUser | null
  pendingInviteCount: number
  colorMode: ColorMode
  googleKey: string
  serverPlacesConfigured: boolean
  ionToken: string
  walkApp: WalkAppPref
  onColorModeChange: (mode: ColorMode) => void
  onOpenExample: () => void
  onImportFile: (f: File) => void
  onExport: () => void
  onExportToDrive: () => void
  onImportFromDrive: (file: DriveFileInfo) => void
  onExportExampleExcel: () => void
  onAddDay: () => void
  onEditTrip: () => void
  onShowTips: () => void
  onStatus: (msg: string) => void
  onCloudUser: (user: CloudUser | null) => void
  onSharedTripChange: (trip: TripRecord) => void | Promise<void>
  onAcceptedTrip: (trip: TripRecord) => void | Promise<void>
  setWalkApp: (pref: WalkAppPref) => void
  setGoogleKey: (v: string) => void
  setIonToken: (v: string) => void
  updateActive: (mutator: (trip: TripRecord) => TripRecord) => Promise<void>
  /** Google Drive block rendered by App (keeps OAuth wiring local). */
  drivePanel: ReactNode
  clientLogs: ReactNode
  /** Open directly into Sharing (e.g. from pending badge). */
  initialSection?: SettingsSectionId | null
}

const btn =
  'cursor-pointer rounded-full border border-[var(--glass-border)] bg-[var(--paper)] px-3 py-2 text-xs font-medium leading-none text-[var(--ink)] shadow-sm inline-flex items-center'
const btnPrimary =
  'cursor-pointer rounded-full bg-[var(--coral)] px-3 py-2 text-xs font-semibold leading-none text-white disabled:opacity-50 inline-flex items-center'

function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>
}

export function SettingsShell(props: SettingsShellProps) {
  const [section, setSection] = useState<SettingsSectionId | null>(
    props.initialSection ?? null,
  )

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div
        className={`flex h-full w-[200%] transition-transform duration-300 ease-out ${
          section ? '-translate-x-1/2' : 'translate-x-0'
        }`}
      >
        {/* Menu */}
        <div className={`w-1/2 min-h-0 ${TOUCH_SCROLL_Y} space-y-1.5 pr-1`}>
          <p className="px-1 pb-1 text-[11px] text-[var(--ink-muted)]">
            Pick a topic — Sharing is where you Join an invite.
          </p>
          {SECTIONS.map((s) => {
            if (s.id === 'trip' && !props.active) return null
            const badge =
              s.id === 'sharing' && props.pendingInviteCount > 0
                ? props.pendingInviteCount
                : 0
            return (
              <button
                key={s.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-xl border border-[var(--glass-border)] bg-[var(--paper-2)] px-3 py-2.5 text-left transition hover:border-[var(--coral)]/35"
                onClick={() => setSection(s.id)}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-[var(--ink)]">{s.title}</div>
                  <div className="truncate text-[10px] text-[var(--ink-muted)]">{s.blurb}</div>
                </div>
                {badge > 0 ? (
                  <span className="shrink-0 rounded-full bg-[var(--coral)] px-1.5 py-0.5 text-[10px] font-bold text-white">
                    {badge}
                  </span>
                ) : (
                  <span className="shrink-0 text-[var(--ink-muted)]" aria-hidden>
                    ›
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Detail */}
        <div className={`flex w-1/2 min-h-0 flex-col pl-1`}>
          <div className="mb-2 flex items-center gap-2 px-0.5">
            <button
              type="button"
              className="rounded-full border border-[var(--glass-border)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ink)]"
              onClick={() => setSection(null)}
            >
              ‹ Settings
            </button>
            <div className="truncate text-[12px] font-bold uppercase tracking-wide text-[var(--ink-muted)]">
              {SECTIONS.find((s) => s.id === section)?.title ?? ''}
            </div>
          </div>
          <div className={`min-h-0 flex-1 space-y-3 ${TOUCH_SCROLL_Y}`}>
            {section === 'sharing' ? (
              <TripSharePanel
                trip={props.active}
                cloudUser={props.cloudUser}
                onCloudUser={props.onCloudUser}
                onTripChange={props.onSharedTripChange}
                onAcceptedTrip={props.onAcceptedTrip}
                onStatus={props.onStatus}
                management
              />
            ) : null}
            {section === 'trip' && props.active ? (
              <TripSection
                active={props.active}
                onEditTrip={props.onEditTrip}
                onAddDay={props.onAddDay}
                updateActive={props.updateActive}
              />
            ) : null}
            {section === 'appearance' ? (
              <AppearanceSection
                colorMode={props.colorMode}
                onColorModeChange={props.onColorModeChange}
              />
            ) : null}
            {section === 'data' ? (
              <DataSection
                active={props.active}
                onImportFile={props.onImportFile}
                onExport={props.onExport}
                onExportExampleExcel={props.onExportExampleExcel}
                drivePanel={props.drivePanel}
              />
            ) : null}
            {section === 'map' ? (
              <MapSection
                walkApp={props.walkApp}
                setWalkApp={props.setWalkApp}
                googleKey={props.googleKey}
                setGoogleKey={props.setGoogleKey}
                serverPlacesConfigured={props.serverPlacesConfigured}
                ionToken={props.ionToken}
                setIonToken={props.setIonToken}
              />
            ) : null}
            {section === 'tools' ? (
              <ToolsSection
                onShowTips={props.onShowTips}
                onOpenExample={props.onOpenExample}
                clientLogs={props.clientLogs}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function TripSection({
  active,
  onEditTrip,
  onAddDay,
  updateActive,
}: {
  active: TripRecord
  onEditTrip: () => void
  onAddDay: () => void
  updateActive: (mutator: (trip: TripRecord) => TripRecord) => Promise<void>
}) {
  return (
    <div className="settings-card">
      <button
        type="button"
        className={`${btn} mb-2 w-full justify-between`}
        onClick={onEditTrip}
      >
        <span className="truncate font-medium">{active.meta.name}</span>
        <span className="shrink-0 text-[var(--ink-muted)]">
          {active.meta.startDate} → {active.meta.endDate}
        </span>
      </button>
      <button type="button" className={`${btn} mb-2 w-full`} onClick={onAddDay}>
        + Add a day
      </button>
      <label className="mb-2 block text-xs text-[var(--ink-muted)]">
        Home currency
        <select
          className="mt-1 w-full rounded-xl border border-[var(--glass-border)] bg-[var(--paper)] px-2 py-1.5 text-sm text-[var(--ink)]"
          value={active.meta.homeCurrency || 'EUR'}
          onChange={(e) =>
            void updateActive((t) => ({
              ...t,
              meta: {
                ...t.meta,
                homeCurrency: normalizeCurrency(e.target.value),
              },
            }))
          }
        >
          {['ILS', 'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD'].map((c) => (
            <option key={c} value={c}>
              {c === 'ILS' ? 'ILS (NIS)' : c}
            </option>
          ))}
        </select>
      </label>
      <textarea
        className="w-full rounded-xl border border-[var(--glass-border)] bg-[var(--paper)] px-2 py-1.5 text-[var(--ink)]"
        rows={3}
        value={active.meta.notes}
        onChange={(e) =>
          void updateActive((t) => ({
            ...t,
            meta: { ...t.meta, notes: e.target.value },
          }))
        }
        placeholder="Notes…"
      />
    </div>
  )
}

function AppearanceSection({
  colorMode,
  onColorModeChange,
}: {
  colorMode: ColorMode
  onColorModeChange: (mode: ColorMode) => void
}) {
  return (
    <div className="settings-card">
      <SegmentedControl
        ariaLabel="Color mode"
        value={colorMode}
        onChange={onColorModeChange}
        options={[
          { id: 'light', label: 'Cream' },
          { id: 'dark', label: 'Dark' },
        ]}
      />
      <p className="mt-2 text-[11px] leading-snug text-[var(--ink-muted)]">
        Cream is the warm paper look; Dark is the glass night shell.
      </p>
    </div>
  )
}

function DataSection({
  active,
  onImportFile,
  onExport,
  onExportExampleExcel,
  drivePanel,
}: {
  active: TripRecord | null
  onImportFile: (f: File) => void
  onExport: () => void
  onExportExampleExcel: () => void
  drivePanel: ReactNode
}) {
  return (
    <div className="settings-card space-y-2">
      <ActionRow>
        <label className={btn}>
          Import Excel
          <input
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onImportFile(f)
              e.target.value = ''
            }}
          />
        </label>
        <button type="button" className={btn} onClick={onExport} disabled={!active}>
          Export Excel
        </button>
        <button type="button" className={btn} onClick={onExportExampleExcel}>
          Example .xlsx
        </button>
      </ActionRow>
      {drivePanel}
      <p className="text-[11px] text-[var(--ink-muted)]">
        Excel uses Trip + Steps + Hotels + Cash. Types: {ITEM_TYPES.join(', ')}.
      </p>
    </div>
  )
}

function MapSection({
  walkApp,
  setWalkApp,
  googleKey,
  setGoogleKey,
  serverPlacesConfigured,
  ionToken,
  setIonToken,
}: {
  walkApp: WalkAppPref
  setWalkApp: (pref: WalkAppPref) => void
  googleKey: string
  setGoogleKey: (v: string) => void
  serverPlacesConfigured: boolean
  ionToken: string
  setIonToken: (v: string) => void
}) {
  return (
    <div className="settings-card">
      <div className="text-xs text-[var(--ink-muted)]">Walk figure opens</div>
      <div className="mt-1 flex flex-wrap gap-2">
        {(
          [
            ['maps', 'Street View'],
            ['earth', 'Google Earth'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`rounded-full px-3 py-1 text-xs ${
              walkApp === id
                ? 'bg-[var(--sky)] text-white'
                : 'border border-[var(--glass-border)] bg-[var(--paper)] text-[var(--ink)]'
            }`}
            onClick={() => setWalkApp(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mt-1 text-[10px] text-[var(--ink-muted)]">
        Basemap look is on the map layers button. Pins → Street View / Earth. Paths →
        directions or Flights.
      </p>
      <label className="mt-3 block text-xs text-[var(--ink-muted)]">
        Google Maps / Places key
        <input
          className="mt-1 w-full rounded-xl border border-[var(--glass-border)] bg-[var(--paper)] px-2 py-1.5 text-sm text-[var(--ink)]"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={googleKey}
          onChange={(e) => setGoogleKey(sanitizeSecretInput(e.target.value))}
          onBlur={() => void setSetting('googleMapsKey', googleKey)}
          placeholder={serverPlacesConfigured ? 'Override server key…' : 'Paste key…'}
        />
        <span className="mt-1 block text-[10px]">
          {serverPlacesConfigured
            ? 'Blank uses the server key. Photoreal 3D needs a key here.'
            : 'Optional. Prefer GOOGLE_MAPS_API_KEY on the server. 3D tiles need a key here.'}
        </span>
      </label>
      <label className="mt-3 block text-xs text-[var(--ink-muted)]">
        Cesium ion token (optional)
        <input
          className="mt-1 w-full rounded-xl border border-[var(--glass-border)] bg-[var(--paper)] px-2 py-1.5 text-sm text-[var(--ink)]"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={ionToken}
          onChange={(e) => setIonToken(sanitizeSecretInput(e.target.value))}
          onBlur={() => void setSetting('cesiumIonToken', ionToken)}
          placeholder="Paste token…"
        />
      </label>
    </div>
  )
}

function ToolsSection({
  onShowTips,
  onOpenExample,
  clientLogs,
}: {
  onShowTips: () => void
  onOpenExample: () => void
  clientLogs: ReactNode
}) {
  return (
    <div className="space-y-3">
      <div className="settings-card">
        <ActionRow>
          <button type="button" className={btnPrimary} onClick={onShowTips}>
            Feature tips
          </button>
          <button type="button" className={btn} onClick={onOpenExample}>
            Open example
          </button>
        </ActionRow>
      </div>
      {clientLogs}
    </div>
  )
}
