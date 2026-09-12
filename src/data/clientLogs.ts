/** In-app client log ring buffer (shown under Data). Secrets are redacted. */

const SECRET_HINT =
  /(?:api[_-]?key|token|secret|password|authorization|bearer|eyJ[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{10,})/i

export type ClientLogLevel = 'info' | 'error'

export type ClientLogEntry = {
  id: number
  t: number
  level: ClientLogLevel
  context: string
  message: string
}

const MAX = 100
let seq = 0
let entries: ClientLogEntry[] = []
const listeners = new Set<() => void>()

function redact(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => (SECRET_HINT.test(part) ? '[redacted]' : part))
    .join('')
    .slice(0, 800)
}

function notify() {
  for (const l of listeners) l()
}

export function appendClientLog(
  level: ClientLogLevel,
  context: string,
  message: unknown,
): void {
  const msg =
    message instanceof Error
      ? redact(message.message)
      : redact(String(message ?? ''))
  seq += 1
  entries = [
    ...entries.slice(-(MAX - 1)),
    {
      id: seq,
      t: Date.now(),
      level,
      context: String(context).slice(0, 64),
      message: msg || '(empty)',
    },
  ]
  notify()
  if (import.meta.env.DEV) {
    const line = `[${context}] ${msg}`
    if (level === 'error') console.error(line)
    else console.info(line)
  }
}

export function logClientInfo(context: string, message: unknown): void {
  appendClientLog('info', context, message)
}

export function clearClientLogs(): void {
  entries = []
  notify()
}

export function getClientLogsSnapshot(): ClientLogEntry[] {
  return entries
}

export function subscribeClientLogs(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

export function formatClientLogsText(list: ClientLogEntry[] = entries): string {
  return list
    .map((e) => {
      const ts = new Date(e.t).toISOString().slice(11, 19)
      return `${ts} ${e.level.toUpperCase()} [${e.context}] ${e.message}`
    })
    .join('\n')
}
