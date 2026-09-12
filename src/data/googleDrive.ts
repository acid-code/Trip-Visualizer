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

let cachedToken: { accessToken: string; expiresAt: number } | null = null
let gsiLoadPromise: Promise<void> | null = null

export function googleDriveClientId(): string {
  return String(import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || '').trim()
}

export function isGoogleDriveConfigured(): boolean {
  return Boolean(googleDriveClientId())
}

function loadGsi(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  if (gsiLoadPromise) return gsiLoadPromise
  gsiLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SCRIPT}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Google sign-in failed to load')))
      if (window.google?.accounts?.oauth2) resolve()
      return
    }
    const script = document.createElement('script')
    script.src = GIS_SCRIPT
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Google sign-in failed to load'))
    document.head.appendChild(script)
  })
  return gsiLoadPromise
}

async function requestAccessToken(interactive: boolean): Promise<string> {
  const clientId = googleDriveClientId()
  if (!clientId) {
    throw new Error(
      'Google Drive is not configured — set VITE_GOOGLE_OAUTH_CLIENT_ID (OAuth web client)',
    )
  }

  if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
    return cachedToken.accessToken
  }

  await loadGsi()
  const oauth2 = window.google?.accounts?.oauth2
  if (!oauth2) throw new Error('Google sign-in is unavailable in this browser')

  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(
            new Error(
              resp.error_description || resp.error || 'Google sign-in was cancelled',
            ),
          )
          return
        }
        const ttlSec = typeof resp.expires_in === 'number' ? resp.expires_in : 3600
        cachedToken = {
          accessToken: resp.access_token,
          expiresAt: Date.now() + ttlSec * 1000,
        }
        resolve(resp.access_token)
      },
      error_callback: (err) => {
        reject(new Error(err.message || err.type || 'Google sign-in failed'))
      },
    })
    client.requestAccessToken({ prompt: interactive ? 'consent' : '' })
  })
}

export async function connectGoogleDrive(): Promise<void> {
  await requestAccessToken(true)
}

export function disconnectGoogleDrive(): void {
  const token = cachedToken?.accessToken
  cachedToken = null
  if (token && window.google?.accounts?.oauth2) {
    try {
      window.google.accounts.oauth2.revoke(token)
    } catch {
      /* ignore */
    }
  }
}

export function isGoogleDriveConnected(): boolean {
  return Boolean(cachedToken && Date.now() < cachedToken.expiresAt - 30_000)
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
    cachedToken = null
    const retryToken = await requestAccessToken(true)
    headers.set('Authorization', `Bearer ${retryToken}`)
    return fetch(url, { ...init, headers })
  }
  return res
}

async function findFolderId(tokenInteractive = false): Promise<string | null> {
  const q = encodeURIComponent(
    `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  )
  const res = await driveFetch(
    `${DRIVE_API}/files?q=${q}&spaces=drive&fields=files(id,name)&pageSize=5`,
    {},
    tokenInteractive,
  )
  if (!res.ok) {
    throw new Error(`Drive folder lookup failed (${res.status})`)
  }
  const data = (await res.json()) as { files?: Array<{ id: string }> }
  return data.files?.[0]?.id ?? null
}

async function ensureTripPlanerFolder(interactive = true): Promise<string> {
  const existing = await findFolderId(interactive)
  if (existing) return existing

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
    throw new Error(`Could not create Drive folder “${DRIVE_FOLDER_NAME}” (${res.status})`)
  }
  const data = (await res.json()) as { id: string }
  return data.id
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
  if (!res.ok) throw new Error(`Drive list failed (${res.status})`)
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
    throw new Error(`Drive upload failed (${res.status})${text ? `: ${text.slice(0, 120)}` : ''}`)
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
  if (!res.ok) throw new Error(`Drive download failed (${res.status})`)
  return res.arrayBuffer()
}

export { DRIVE_FOLDER_NAME }
