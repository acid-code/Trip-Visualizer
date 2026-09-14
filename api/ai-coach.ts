/**
 * Day Coach proxy → Gemini JSON with model fallbacks.
 * Fully self-contained for Vercel (no ../src imports).
 *
 * Free-tier reality (text-out): most Flash models ≈ 20 RPD; Flash Lite ≈ 500 RPD.
 * Prefer Lite for headroom, then quality Flash if Lite is down/quota-exhausted.
 *
 * Client may call twice: propose, then revise with critiqueFeedback (max 1 revise).
 */

export const config = {
  maxDuration: 60,
}

/**
 * Ordered cascade. Override primary with GEMINI_MODEL (still falls through the rest).
 * IDs match Google AI Studio / generativelanguage.googleapis.com.
 */
const DEFAULT_MODELS = [
  'gemini-3.5-flash-lite', // ~500 RPD — best free-tier headroom for coach
  'gemini-3.1-flash-lite', // ~500 RPD — sibling Lite
  'gemini-3.6-flash', // better quality, ~20 RPD
  'gemini-3.8-flash', // newer Flash if 3.6 is exhausted
  'gemini-2.5-flash-lite', // older Lite fallback
] as const

function modelCascade(): string[] {
  const preferred = String(process.env.GEMINI_MODEL ?? '').trim()
  const base = [...DEFAULT_MODELS]
  if (preferred) {
    return [preferred, ...base.filter((m) => m !== preferred)]
  }
  return base
}

function geminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
}

function isRetryableModelError(status: number, message: string): boolean {
  if (status === 429) return true
  if (status === 503 || status === 500) return true
  return /RESOURCE_EXHAUSTED|quota|rate.?limit|not found|NOT_FOUND|unsupported|invalid model/i.test(
    message,
  )
}

type VercelReq = {
  method?: string
  body?: unknown
  headers?: Record<string, string | string[] | undefined>
}

type VercelRes = {
  status: (code: number) => VercelRes
  setHeader: (name: string, value: string) => void
  json: (body: unknown) => void
  send: (body: string) => void
}

function header(req: VercelReq, name: string): string {
  const raw = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  if (Array.isArray(raw)) return raw[0] || ''
  return typeof raw === 'string' ? raw : ''
}

function originAllowed(req: VercelReq): boolean {
  const origin = header(req, 'origin') || header(req, 'referer')
  if (!origin) return true
  try {
    const host = new URL(origin).hostname
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.endsWith('.vercel.app') ||
      host === 'trip-visualizer-eta.vercel.app'
    )
  } catch {
    return false
  }
}

function clamp(s: string, n: number): string {
  return s.trim().slice(0, n)
}

const SYSTEM = `You are Day Coach for a trip journal app. You ONLY improve ONE calendar day.
You never invent places. You may ONLY reference candidate ids from the provided candidates list.
You never change other days.

Use planningHints and dayFillLevel as the day diagnosis.

Match effort to dayFillLevel:
- empty: help fill THIS day. For fill/fun/plan/sights, prefer cafe + ≥1 sights/nature + lunch + dinner — NEVER lunch+dinner alone and NEVER only a café. If dayItems include isPlaceholder day-base shells, replace them: add removeSteps for those item ids when you add real stops (the client also upgrades the base into the first new stop). Never leave a fake “Day N base” hotel next to a filled plan.
- partial: offer 1–3 light tweaks (activity add, meal-gap fill, trim or pace). Do NOT rebuild the whole day.
- full: offer 1–3 polish options (trim, quality upgrade, pacing) — not a new full itinerary.

Quality over quantity: return 1–3 solid options. One strong option is fine. Do not pad with weak duplicates.
Never schedule the same candidate twice on one day at different hours — each addSteps entry needs a distinct place.

Default meal arc on empty food fills (3 stops unless user asks otherwise):
1) morning cafe ~09:00
2) lunch ~13:00
3) evening romantic / high-rated dinner OR high-rated pub ~19:30
Add a later pub (~21:00) ONLY if the user asks for drinks after dinner.
Fun/activity/sights/city asks must use sights or nature candidates — never a restaurant substitute. Fill+sights must include actionable sight stops, not only meals. The same rules apply in cities and in countryside.
Wine tasting: when asked, include ONE winery/wine-cellar candidate as a stop inside a normal day — not a wine-only itinerary. Pair with sights/meals when the user also asked to fill/explore. Never reuse the tasting venue as café/sight/dinner.
Water / beach / lake / seaside asks: include at least one beach, lake, marina, harbour, waterfront, or coastal promenade candidate (sights or nature). Prefer seafood or waterfront restaurants when available. Do not plan lunch and dinner as two pizzerias — vary cuisine.
Star-shaped trips (same hotel several nights): never reuse places already on other days — pick fresh candidates for THIS day only.
Drives: compact city — addDrives only for stops roughly ≥3 km (shorter hops are walks). Open countryside / Provence-style — addDrives even for ~2 km village hops. Always drive farther out-of-town stops. Chain drives stop→stop in time order (first hop may use fromItemId for hotel/vehicle; later hops use fromCandidateId of the previous addSteps stop). Never fan every drive out from day start.

Clarifications:
- Payload may include lines: "Original request:", "Coach asked:", "User replied:".
- Short answers like "first one" / "the second" / a place name refer to the LAST "Coach asked" question.
- Resolve that answer, then return options. Do NOT ask the same clarifying question again.

Critique / revise loop:
- Payload may include critiqueFeedback: an array of concrete problems with your previous options.
- When critiqueFeedback is present, FIX every listed issue and return corrected options (or clarification if truly blocked). Do not repeat the same mistakes. Prefer repairing patches over asking a new question.

Respond with JSON only, one of:
{"kind":"need_clarification","question":"short question"}
{"kind":"options","options":[{
  "id":"opt1",
  "label":"Short label",
  "kind":"food|highlight|viewpoint|pacing|itinerary|trim|other",
  "summary":"one line",
  "rationale":"why",
  "patch":{
    "addSteps":[{"candidateId":"...","start":"HH:MM","note":"optional"}],
    "addDrives":[{"fromItemId":"optional existing step id","fromCandidateId":"optional prior candidateId","toCandidateId":"...","start":"HH:MM"}],
    "setTimes":[{"itemId":"...","start":"HH:MM"}],
    "removeSteps":[{"itemId":"..."}],
    "addNote":{"title":"...","notes":"...","start":"HH:MM"}
  }
}]}

Rules:
- Prefer options over clarification unless truly blocked (no usable candidates / impossible constraint).
- Every addSteps/addDrives toCandidateId MUST exist in candidates.
- setTimes / removeSteps itemId MUST be ids from dayItems for this day.
- When addDrives points at a place, ALSO include that place in addSteps (stop must appear, not only the drive).
- Empty + drive/countryside: at least one itinerary with addDrives + optional viewpoint + destination + meals.
- Prefer destination/along_route for countryside days — avoid airport-only food clusters.
- If dayItems include isVehicleStop, start the FIRST drive from that fromItemId; subsequent drives should use fromCandidateId of the previous stop.
- Meal timing: cafe ~08:30-10:00, lunch ~12:00-14:00, dinner/pub ~19:00-21:00.
- Opening hours: candidates may include openingHours and openHint for THIS day. Never schedule addSteps/addDrives to a place at a time it is closed. Prefer places whose openHint covers the visit time. If hours are unknown, you may still suggest them.
- Never remove flights, hotels, or placeholders via trim.
- Trim options: removeSteps must use exact dayItems.id where canRemove is true (or matching title). On a busy/full day remove 2–4 weaker content stops — enough that the day feels lighter. Do not only remove a single trivial note when many sights exist.
- Do not propose new hotels. Do not invent car dealerships.
- Keep labels under 40 chars.`

export default async function handler(req: VercelReq, res: VercelRes) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.status(204).send('')
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  if (!originAllowed(req)) {
    res.status(403).json({ error: 'Origin not allowed' })
    return
  }

  const apiKey = String(process.env.GEMINI_API_KEY ?? '').trim()
  if (!apiKey) {
    res.status(503).json({ error: 'GEMINI_API_KEY not configured' })
    return
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
    string,
    unknown
  >
  const day = clamp(String(body.day ?? ''), 10)
  const userMessage = clamp(String(body.userMessage ?? ''), 2000)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    res.status(400).json({ error: 'Invalid day' })
    return
  }
  if (!userMessage) {
    res.status(400).json({ error: 'Missing user message' })
    return
  }

  const critiqueFeedback = Array.isArray(body.critiqueFeedback)
    ? body.critiqueFeedback.map((c) => clamp(String(c), 300)).filter(Boolean).slice(0, 12)
    : []

  const payload = {
    day,
    userMessage,
    clarifications: Array.isArray(body.clarifications)
      ? body.clarifications.map((c) => clamp(String(c), 500)).slice(0, 12)
      : [],
    tripName: clamp(String(body.tripName ?? ''), 200),
    travelers: clamp(String(body.travelers ?? ''), 200),
    notes: clamp(String(body.notes ?? ''), 1500),
    thinDay: Boolean(body.thinDay),
    dayFillLevel: ['empty', 'partial', 'full'].includes(String(body.dayFillLevel))
      ? String(body.dayFillLevel)
      : body.thinDay
        ? 'empty'
        : 'partial',
    anchor: body.anchor ?? null,
    dayItems: Array.isArray(body.dayItems) ? body.dayItems.slice(0, 40) : [],
    candidates: Array.isArray(body.candidates) ? body.candidates.slice(0, 56) : [],
    planningHints: Array.isArray(body.planningHints)
      ? body.planningHints.map((h) => clamp(String(h), 240)).slice(0, 16)
      : [],
    ...(critiqueFeedback.length ? { critiqueFeedback } : {}),
  }

  const reviseNote = critiqueFeedback.length
    ? `\n\nREVISION REQUIRED — fix these critique issues before answering:\n${critiqueFeedback
        .map((c, i) => `${i + 1}. ${c}`)
        .join('\n')}`
    : ''

  const userText = `Full day context (authoritative — ignore any chat memory):\n${JSON.stringify(payload)}${reviseNote}`
  const models = modelCascade()
  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: critiqueFeedback.length ? 0.35 : 0.45,
      responseMimeType: 'application/json',
    },
  })

  try {
    let lastError = 'Gemini unavailable'
    let usedModel = models[0] || 'unknown'

    for (let i = 0; i < models.length; i++) {
      const model = models[i]!
      usedModel = model
      const upstream = await fetch(
        `${geminiUrl(model)}?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
        },
      )

      const raw = (await upstream.json()) as {
        error?: { message?: string; status?: string }
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> }
        }>
      }

      if (!upstream.ok) {
        lastError = raw.error?.message || `Gemini HTTP ${upstream.status}`
        if (
          i < models.length - 1 &&
          isRetryableModelError(upstream.status, lastError)
        ) {
          continue
        }
        res.status(502).json({ error: lastError, model })
        return
      }

      const text =
        raw.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ||
        ''
      if (!text.trim()) {
        lastError = 'Empty Gemini response'
        if (i < models.length - 1) continue
        res.status(502).json({ error: lastError, model })
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        const start = text.indexOf('{')
        const end = text.lastIndexOf('}')
        if (start >= 0 && end > start) {
          try {
            parsed = JSON.parse(text.slice(start, end + 1))
          } catch {
            lastError = 'Gemini returned non-JSON'
            if (i < models.length - 1) continue
            res.status(502).json({ error: lastError, model })
            return
          }
        } else {
          lastError = 'Gemini returned non-JSON'
          if (i < models.length - 1) continue
          res.status(502).json({ error: lastError, model })
          return
        }
      }

      const obj = parsed as Record<string, unknown>
      if (obj.kind === 'need_clarification') {
        const question = clamp(String(obj.question ?? ''), 400)
        if (!question) {
          lastError = 'Bad clarification'
          if (i < models.length - 1) continue
          res.status(502).json({ error: lastError, model })
          return
        }
        res.status(200).json({
          kind: 'need_clarification',
          question,
          model: usedModel,
        })
        return
      }

      if (obj.kind === 'options' && Array.isArray(obj.options)) {
        res.status(200).json({
          kind: 'options',
          options: obj.options.slice(0, 5),
          model: usedModel,
        })
        return
      }

      lastError = 'Unexpected Gemini shape'
      if (i < models.length - 1) continue
      res.status(502).json({ error: lastError, model })
      return
    }

    res.status(502).json({ error: lastError })
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : 'Gemini proxy failed',
    })
  }
}
