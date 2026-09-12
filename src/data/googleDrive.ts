/**
 * Google Drive sync for trip Excel workbooks.
 * Uses Google Identity Services (browser OAuth) + Drive REST API.
 * Files live under a folder named `trip-planer/` that this app creates.
 */

const DRIVE_FOLDER_NAME = 'trip-planer'
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const GIS_SCRIPT = 'https://accounts.google.com/gsi/client'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const TOKEN_STORAGE_KEY = 'trip-drive-oauth'
const FOLDER_STORAGE_KEY = 'trip-drive-folder-id'
const TRIP_FILE_MAP_KEY = 'trip-drive-file-map'

export type DriveFileInfo = {
  id: string
  name: string
  modifiedTime?: string
  webViewLink?: string
}

type TokenResponse = {
  access_token?: string
  error?: string
  error_description?: string
  expires_in?: number
}

type TokenClient = {
  requestAccessToken: (override?: { prompt?: string }) => void
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string
            scope: string
            callback: (resp: TokenResponse) => void
            error_callback?: (err: { type?: string; message?: string }) => void
          }) => TokenClient
          revoke: (token: string, done?: () => void) => void
        }
      }
    }
  }
}

type CachedToken = { accessToken: string; expiresAt: number }

let cachedToken: CachedToken | null = readStoredToken()
let gsiLoadPromise: Promise<void> | null = null
let tokenClient: TokenClient | null = null

export function googleDriveClientId(): string {
  return String(import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || '').trim()
}

export function isGoogleDriveConfigured(): boolean {
  return Boolean(googleDriveClientId())
}

function readStoredToken(): CachedToken | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedToken
    if (!parsed?.accessToken || !parsed.expiresAt) return null
    if (Date.now() >= parsed.expiresAt - 30_000) return null
    return parsed
  } catch {
    return null
  }
}

function persistToken(token: CachedToken | null) {
  cachedToken = token
  try {
    if (!token) sessionStorage.removeItem(TOKEN_STORAGE_KEY)
    else sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token))
  } catch {
    /* ignore quota / private mode */
  }
}

function loadGsi(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  if (gsiLoadPromise) return gsiLoadPromise
  gsiLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SCRIPT}"]`)
    if (existing) {
      const done = () => {
        if (window.google?.accounts?.oauth2) resolve()
        else reject(new Error('Google sign-in failed to load'))
      }
      if (window.google?.accounts?.oauth2) {
        resolve()
        return
      }
      existing.addEventListener('load', done)
      existing.addEventListener('error', () =>
        reject(new Error('Google sign-in failed to load')),
      )
      return
    }
    const script = document.createElement('script')
    script.src = GIS_SCRIPT
    script.async = true
    script.onload = () => {
      if (window.google?.accounts?.oauth2) resolve()
      else reject(new Error('Google sign-in failed to load'))
    }
    script.onerror = () => reject(new Error('Google sign-in failed to load'))
    document.head.appendChild(script)
  })
  return gsiLoadPromise
}

function explainAuthError(err: { type?: string; message?: string } | Error): string {
  const type = 'type' in err ? err.type : ''
  const message = err instanceof Error ? err.message : err.message || ''
  const host = typeof window !== 'undefined' ? window.location.origin : ''
  const localHint =
    host.startsWith('http://localhost') || host.startsWith('http://127.0.0.1')
      ? ` In Google Cloud → OAuth client, add this exact origin under Authorized JavaScript origins: ${host}`
      : ''

  if (type === 'popup_closed' || /popup/i.test(message)) {
    return (
      'Google sign-in could not finish talking to this tab (often looks like “popup closed” even while the window is open). ' +
      'Restart the Vite dev server so Cross-Origin-Opener-Policy is applied, allow popups, and match Authorized JavaScript origins exactly.' +
      localHint
    )
  }
  if (type === 'popup_failed_to_open') {
    return 'Browser blocked the Google sign-in popup. Allow popups for this site and retry.'
  }
  return (message || type || 'Google sign-in failed') + localHint
}

async function ensureTokenClient(
  onToken: (resp: TokenResponse) => void,
  onError: (err: { type?: string; message?: string }) => void,
): Promise<TokenClient> {
  const clientId = googleDriveClientId()
  if (!clientId) {
    throw new Error(
      'Google Drive is not configured — set VITE_GOOGLE_OAUTH_CLIENT_ID (OAuth web client)',
    )
  }
  await loadGsi()
  const oauth2 = window.google?.accounts?.oauth2
  if (!oauth2) throw new Error('Google sign-in is unavailable in this browser')

  // Recreate each time so the latest callbacks close the current Promise.
  tokenClient = oauth2.initTokenClient({
    client_id: clientId,
    scope: DRIVE_SCOPE,
    callback: onToken,
    error_callback: onError,
  })
  return tokenClient
}

async function requestAccessToken(interactive: boolean): Promise<string> {
  const existing = cachedToken ?? readStoredToken()
  if (existing && Date.now() < existing.expiresAt - 30_000) {
    cachedToken = existing
    return existing.accessToken
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    // If the GSI transform page hangs, don't leave the UI spinning forever.
    const timer = window.setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            'Google sign-in timed out. Close the Google tab/popup, refresh this page, and try again.',
          ),
        ),
      )
    }, 120_000)

    void ensureTokenClient(
      (resp) => {
        if (resp.error || !resp.access_token) {
          finish(() =>
            reject(
              new Error(
                resp.error_description || resp.error || 'Google sign-in was cancelled',
              ),
            ),
          )
          return
        }
        const ttlSec = typeof resp.expires_in === 'number' ? resp.expires_in : 3600
        persistToken({
          accessToken: resp.access_token,
          expiresAt: Date.now() + ttlSec * 1000,
        })
        finish(() => resolve(resp.access_token!))
      },
      (err) => {
        finish(() => reject(new Error(explainAuthError(err))))
      },
    )
      .then((client) => {
        // Empty prompt = consent only when Google still needs it (avoids repeat hangs).
        // Interactive connect may still need account picker once.
        client.requestAccessToken({
          prompt: interactive ? 'select_account' : '',
        })
      })
      .catch((err) => {
        finish(() =>
          reject(err instanceof Error ? err : new Error(explainAuthError(err as Error))),
        )
      })
  })
}

export async function connectGoogleDrive(): Promise<void> {
  await requestAccessToken(true)
}

export function disconnectGoogleDrive(): void {
  const token = cachedToken?.accessToken
  persistToken(null)
  tokenClient = null
  try {
    localStorage.removeItem(FOLDER_STORAGE_KEY)
  } catch {
    /* ignore */
  }
  if (token && window.google?.accounts?.oauth2) {
    try {
      window.google.accounts.oauth2.revoke(token)
    } catch {
      /* ignore */
    }
  }
}

export function isGoogleDriveConnected(): boolean {
  const t = cachedToken ?? readStoredToken()
  return Boolean(t && Date.now() < t.expiresAt - 30_000)
}

async function driveFetch(
  url: string,
  init: RequestInit = {},
  interactive = false,
): Promise<Response> {
  const token = await requestAccessToken(interactive)
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  // Let the browser set multipart boundary when body is FormData
  if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
    headers.delete('Content-Type')
  }
  const res = await fetch(url, { ...init, headers })
  if (res.status === 401) {
    persistToken(null)
    const retryToken = await requestAccessToken(true)
    headers.set('Authorization', `Bearer ${retryToken}`)
    if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
      headers.delete('Content-Type')
    }
    return fetch(url, { ...init, headers })
  }
  return res
}

async function driveErrorMessage(res: Response, fallback: string): Promise<string> {
  let body = ''
  try {
    body = await res.text()
  } catch {
    /* ignore */
  }
  type DriveErr = {
    error?: {
      message?: string
      status?: string
      errors?: Array<{ reason?: string; message?: string }>
    }
  }
  let parsed: DriveErr | null = null
  try {
    parsed = body ? (JSON.parse(body) as DriveErr) : null
  } catch {
    parsed = null
  }
  const apiMessage =
    parsed?.error?.message ||
    parsed?.error?.errors?.[0]?.message ||
    (body ? body.slice(0, 160) : '')
  const blob = `${apiMessage} ${parsed?.error?.status || ''} ${parsed?.error?.errors?.[0]?.reason || ''}`

  if (res.status === 403) {
    if (/accessNotConfigured|has not been used|API has not been|disabled/i.test(blob)) {
      return (
        'Google Drive API is not enabled for this Cloud project. Open Google Cloud Console → ' +
        'APIs & Services → Library → enable “Google Drive API”, wait ~1 minute, then Connect again.'
      )
    }
    if (/insufficientPermissions|PERMISSION_DENIED|accessDenied/i.test(blob)) {
      return (
        'Drive access was denied. Disconnect, Connect Google again, and accept the Drive permission.'
      )
    }
  }

  return apiMessage
    ? `${fallback} (${res.status}: ${apiMessage})`
    : `${fallback} (${res.status})`
}

function readStoredFolderId(): string | null {
  try {
    return localStorage.getItem(FOLDER_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredFolderId(id: string | null) {
  try {
    if (!id) localStorage.removeItem(FOLDER_STORAGE_KEY)
    else localStorage.setItem(FOLDER_STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
}

async function verifyFolderId(
  folderId: string,
  interactive = false,
): Promise<string | null> {
  const res = await driveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,name,trashed,mimeType`,
    {},
    interactive,
  )
  if (!res.ok) {
    writeStoredFolderId(null)
    return null
  }
  const data = (await res.json()) as {
    id?: string
    trashed?: boolean
    mimeType?: string
  }
  if (!data.id || data.trashed || data.mimeType !== 'application/vnd.google-apps.folder') {
    writeStoredFolderId(null)
    return null
  }
  return data.id
}

async function findFolderId(tokenInteractive = false): Promise<string | null> {
  const remembered = readStoredFolderId()
  if (remembered) {
    const ok = await verifyFolderId(remembered, tokenInteractive)
    if (ok) return ok
  }

  const q = encodeURIComponent(
    `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  )
  const res = await driveFetch(
    `${DRIVE_API}/files?q=${q}&spaces=drive&fields=files(id,name)&pageSize=5`,
    {},
    tokenInteractive,
  )
  if (!res.ok) {
    // With drive.file, search can be picky — caller may still create a folder.
    if (res.status === 404 || res.status === 400) return null
    throw new Error(await driveErrorMessage(res, 'Drive folder lookup failed'))
  }
  const data = (await res.json()) as { files?: Array<{ id: string }> }
  const id = data.files?.[0]?.id ?? null
  if (id) writeStoredFolderId(id)
  return id
}

async function createTripPlanerFolder(interactive = true): Promise<string> {
  const res = await driveFetch(
    `${DRIVE_API}/files?fields=id,name`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: DRIVE_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    },
    interactive,
  )
  if (!res.ok) {
    throw new Error(await driveErrorMessage(res, `Could not create Drive folder “${DRIVE_FOLDER_NAME}”`))
  }
  const data = (await res.json()) as { id: string }
  writeStoredFolderId(data.id)
  return data.id
}

async function ensureTripPlanerFolder(interactive = true): Promise<string> {
  try {
    const existing = await findFolderId(interactive)
    if (existing) return existing
  } catch (err) {
    // If lookup is forbidden but API works for create, still try create.
    const msg = err instanceof Error ? err.message : ''
    if (!/403|not enabled|denied/i.test(msg)) throw err
  }
  return createTripPlanerFolder(interactive)
}

function readTripFileMap(): Record<string, { fileId: string; fileName: string }> {
  try {
    const raw = localStorage.getItem(TRIP_FILE_MAP_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, { fileId: string; fileName: string }>
  } catch {
    return {}
  }
}

function writeTripFileMap(map: Record<string, { fileId: string; fileName: string }>) {
  try {
    localStorage.setItem(TRIP_FILE_MAP_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

export function rememberDriveFileForTrip(
  tripId: string,
  fileId: string,
  fileName: string,
): void {
  const map = readTripFileMap()
  map[tripId] = { fileId, fileName }
  writeTripFileMap(map)
}

export function getRememberedDriveFileForTrip(
  tripId: string,
): { fileId: string; fileName: string } | null {
  return readTripFileMap()[tripId] ?? null
}

export function getStoredDriveFolderId(): string | null {
  return readStoredFolderId()
}

/** Opens in Drive web / app (folder). */
export function driveFolderWebUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`
}

/** Opens in Drive web / app (file). */
export function driveFileWebUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`
}

export async function resolveDriveFolderOpenUrl(): Promise<string | null> {
  const id = readStoredFolderId() || (await ensureTripPlanerFolder(true))
  return id ? driveFolderWebUrl(id) : null
}

export function slugTripFileBase(tripName: string): string {
  const s = tripName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'trip'
}

/** Strip .xlsx and optional -2/-3 suffix used for duplicate Drive names. */
export function tripNameSlugFromDriveFileName(fileName: string): string {
  return fileName
    .replace(/\.xlsx?$/i, '')
    .replace(/-\d+$/, '')
    .trim()
    .toLowerCase()
}

function uniqueWorkbookName(base: string, existingNames: string[]): string {
  const want = `${base}.xlsx`
  const lower = new Set(existingNames.map((n) => n.toLowerCase()))
  if (!lower.has(want.toLowerCase())) return want
  for (let i = 2; i < 200; i++) {
    const candidate = `${base}-${i}.xlsx`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
  return `${base}-${Date.now()}.xlsx`
}

async function listFilesInFolder(folderId: string): Promise<DriveFileInfo[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`)
  const res = await driveFetch(
    `${DRIVE_API}/files?q=${q}&spaces=drive&fields=files(id,name,modifiedTime,webViewLink)&pageSize=100&orderBy=modifiedTime desc`,
  )
  if (!res.ok) throw new Error(await driveErrorMessage(res, 'Drive list failed'))
  const data = (await res.json()) as { files?: DriveFileInfo[] }
  return data.files ?? []
}

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function asBinaryBody(bytes: ArrayBuffer): Blob {
  return new Blob([new Uint8Array(bytes)], { type: XLSX_MIME })
}

function assertXlsxBytes(bytes: ArrayBuffer): void {
  const u8 = new Uint8Array(bytes)
  if (u8.byteLength < 64 || u8[0] !== 0x50 || u8[1] !== 0x4b) {
    throw new Error('Workbook bytes are not a valid .xlsx — export aborted')
  }
}

async function createDriveFileMetadata(
  folderId: string,
  fileName: string,
): Promise<string> {
  const res = await driveFetch(
    `${DRIVE_API}/files?fields=id,name`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: fileName,
        parents: [folderId],
        mimeType: XLSX_MIME,
      }),
    },
    true,
  )
  if (!res.ok) {
    throw new Error(await driveErrorMessage(res, 'Could not create Drive file'))
  }
  const data = (await res.json()) as { id: string }
  return data.id
}

async function uploadDriveFileMedia(
  fileId: string,
  bytes: ArrayBuffer,
): Promise<{ id: string; name: string; mimeType?: string; size?: string }> {
  const res = await driveFetch(
    `${DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,mimeType,size,modifiedTime`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': XLSX_MIME },
      body: asBinaryBody(bytes),
    },
    true,
  )
  if (!res.ok) {
    throw new Error(await driveErrorMessage(res, 'Drive content upload failed'))
  }
  return (await res.json()) as {
    id: string
    name: string
    mimeType?: string
    size?: string
  }
}

async function updateExistingDriveFile(
  fileId: string,
  fileName: string,
  bytes: ArrayBuffer,
): Promise<{ fileName: string; fileId: string }> {
  assertXlsxBytes(bytes)
  const metaRes = await driveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: fileName, mimeType: XLSX_MIME }),
    },
    true,
  )
  if (!metaRes.ok) {
    throw new Error(await driveErrorMessage(metaRes, 'Drive file update failed'))
  }

  const data = await uploadDriveFileMedia(fileId, bytes)
  if (data.mimeType && /google-apps\.(spreadsheet|document)/i.test(data.mimeType)) {
    throw new Error('Drive converted the file — try Save to Drive again')
  }
  const size = data.size ? Number(data.size) : 0
  if (size > 0 && size < 64) {
    throw new Error('Drive upload looked empty — try Save to Drive again')
  }
  return { fileName: data.name || fileName, fileId: data.id || fileId }
}

/** Upload workbook bytes into trip-planer/. Updates the same file when tripId was saved before. */
export async function uploadTripWorkbookToDrive(
  tripName: string,
  bytes: ArrayBuffer,
  tripId?: string,
): Promise<{ fileName: string; fileId: string }> {
  assertXlsxBytes(bytes)
  const folderId = await ensureTripPlanerFolder(true)
  const files = await listFilesInFolder(folderId)
  const base = slugTripFileBase(tripName)

  if (tripId) {
    const remembered = getRememberedDriveFileForTrip(tripId)
    if (remembered && files.some((f) => f.id === remembered.fileId)) {
      const updated = await updateExistingDriveFile(
        remembered.fileId,
        `${base}.xlsx`,
        bytes,
      )
      rememberDriveFileForTrip(tripId, updated.fileId, updated.fileName)
      return updated
    }
    const byName = files.find((f) => f.name.toLowerCase() === `${base}.xlsx`)
    if (byName) {
      const updated = await updateExistingDriveFile(byName.id, byName.name, bytes)
      rememberDriveFileForTrip(tripId, updated.fileId, updated.fileName)
      return updated
    }
  }

  const fileName = uniqueWorkbookName(
    base,
    files.map((f) => f.name),
  )

  // Two-step upload (metadata JSON, then raw media) — FormData multipart/form-data
  // corrupts binary .xlsx on Drive and Sheets cannot open the result.
  const fileId = await createDriveFileMetadata(folderId, fileName)
  const data = await uploadDriveFileMedia(fileId, bytes)
  if (data.mimeType && /google-apps\.(spreadsheet|document)/i.test(data.mimeType)) {
    throw new Error(
      'Drive converted the workbook to a Google Doc — re-save and keep .xlsx.',
    )
  }
  const size = data.size ? Number(data.size) : 0
  if (size > 0 && size < 64) {
    throw new Error('Drive upload looked empty — try Save to Drive again')
  }
  const out = { fileName: data.name || fileName, fileId: data.id || fileId }
  if (tripId) rememberDriveFileForTrip(tripId, out.fileId, out.fileName)
  return out
}

/** List .xlsx workbooks in trip-planer/ (creates the folder if needed). */
export async function listTripWorkbooksOnDrive(): Promise<DriveFileInfo[]> {
  const folderId = await ensureTripPlanerFolder(true)
  const files = await listFilesInFolder(folderId)
  return files.filter((f) => /\.xlsx?$/i.test(f.name))
}

export async function downloadDriveFile(fileId: string): Promise<ArrayBuffer> {
  // Prefer native binary download; if Drive converted to Google Sheet, export as xlsx.
  const metaRes = await driveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`,
    {},
    true,
  )
  if (!metaRes.ok) {
    throw new Error(await driveErrorMessage(metaRes, 'Drive file lookup failed'))
  }
  const meta = (await metaRes.json()) as { mimeType?: string }

  if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
    const exp = await driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`,
      {},
      true,
    )
    if (!exp.ok) {
      throw new Error(await driveErrorMessage(exp, 'Drive Sheets export failed'))
    }
    return exp.arrayBuffer()
  }

  const res = await driveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
    {},
    true,
  )
  if (!res.ok) throw new Error(await driveErrorMessage(res, 'Drive download failed'))
  return res.arrayBuffer()
}

export async function getDriveFileMeta(fileId: string): Promise<DriveFileInfo> {
  const res = await driveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,modifiedTime,webViewLink,mimeType`,
    {},
    true,
  )
  if (!res.ok) throw new Error(await driveErrorMessage(res, 'Drive file lookup failed'))
  return (await res.json()) as DriveFileInfo
}

export { DRIVE_FOLDER_NAME }
