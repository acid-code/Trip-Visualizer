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

export type DriveFileInfo = {
  id: string
  name: string
  modifiedTime?: string
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
  const res = await fetch(url, { ...init, headers })
  if (res.status === 401) {
    persistToken(null)
    const retryToken = await requestAccessToken(true)
    headers.set('Authorization', `Bearer ${retryToken}`)
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

export function slugTripFileBase(tripName: string): string {
  const s = tripName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'trip'
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
    `${DRIVE_API}/files?q=${q}&spaces=drive&fields=files(id,name,modifiedTime)&pageSize=100&orderBy=modifiedTime desc`,
  )
  if (!res.ok) throw new Error(await driveErrorMessage(res, 'Drive list failed'))
  const data = (await res.json()) as { files?: DriveFileInfo[] }
  return data.files ?? []
}

/** Upload workbook bytes into trip-planer/, with -2/-3 suffix if the name exists. */
export async function uploadTripWorkbookToDrive(
  tripName: string,
  bytes: ArrayBuffer,
): Promise<{ fileName: string; fileId: string }> {
  const folderId = await ensureTripPlanerFolder(true)
  const files = await listFilesInFolder(folderId)
  const fileName = uniqueWorkbookName(
    slugTripFileBase(tripName),
    files.map((f) => f.name),
  )

  const metadata = {
    name: fileName,
    parents: [folderId],
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }

  const boundary = `tripbound_${Date.now().toString(36)}`
  const metaPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n`
  const fileHeader =
    `--${boundary}\r\n` +
    `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`
  const footer = `\r\n--${boundary}--`

  const metaBytes = new TextEncoder().encode(metaPart + fileHeader)
  const footerBytes = new TextEncoder().encode(footer)
  const body = new Uint8Array(metaBytes.length + bytes.byteLength + footerBytes.length)
  body.set(metaBytes, 0)
  body.set(new Uint8Array(bytes), metaBytes.length)
  body.set(footerBytes, metaBytes.length + bytes.byteLength)

  const res = await driveFetch(
    `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
    true,
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // Re-wrap for consistent messaging
    const fake = {
      ok: false,
      status: res.status,
      text: async () => text,
    } as Response
    throw new Error(await driveErrorMessage(fake, 'Drive upload failed'))
  }
  const data = (await res.json()) as { id: string; name: string }
  return { fileName: data.name || fileName, fileId: data.id }
}

/** List .xlsx workbooks in trip-planer/ (creates the folder if needed). */
export async function listTripWorkbooksOnDrive(): Promise<DriveFileInfo[]> {
  const folderId = await ensureTripPlanerFolder(true)
  const files = await listFilesInFolder(folderId)
  return files.filter((f) => /\.xlsx?$/i.test(f.name))
}

export async function downloadDriveFile(fileId: string): Promise<ArrayBuffer> {
  const res = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {}, true)
  if (!res.ok) throw new Error(await driveErrorMessage(res, 'Drive download failed'))
  return res.arrayBuffer()
}

export { DRIVE_FOLDER_NAME }
