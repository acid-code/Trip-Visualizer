/**
 * Multi-mode Gemini JSON proxy for Trip Planner / area tips / ingest / enrich.
 * Self-contained for Vercel (no ../src imports).
 */

export const config = {
  maxDuration: 60,
}

const DEFAULT_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.8-flash',
  'gemini-2.5-flash-lite',
] as const

function modelCascade(): string[] {
  const preferred = String(process.env.GEMINI_MODEL ?? '').trim()
  const base = [...DEFAULT_MODELS]
  if (preferred) return [preferred, ...base.filter((m) => m !== preferred)]
  return base
}

function geminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
}

function isRetryableModelError(status: number, message: string): boolean {
  if (status === 429 || status === 503 || status === 500) return true
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

const SHARED_RULES = `
Hard rules for all modes:
- Never invent specific hotel names, bookings, confirmation codes, or prices.
- Recommend city/region/neighborhood stay-zones only for lodging; user books hotels themselves.
- Prefer several options over one rigid plan.
- Ask at most one clarifying question when blocked.
- Area-first: neighborhoods and geographic flow matter more than isolated POIs.
- Flag car_useful / car_needed when hops imply a car; do not assume a car.
- Calendar caveats (Sunday closures, festivals) when relevant.
- Respond with JSON only.
`

const SYSTEMS: Record<string, string> = {
  area_tips: `You suggest regions and best neighborhoods for a trip journal app.
${SHARED_RULES}
Return: {"tips":[{"id":"a1","areaLabel":"...","country":"...","vibeTags":[],"whyGo":"...","roughNights":2,"transportHint":"walk_city|transit_ok|car_useful|car_needed","neighborhoods":[{"label":"...","vibeTags":[],"whyStayHere":"...","nightWalk":true,"budgetFit":"..."}],"caveatsLite":[]}]}
Return 3-6 tips. No hotel names.`,

  trip_ingest: `You extract a first trip draft from free text.
${SHARED_RULES}
Return one of:
{"kind":"need_clarification","question":"..."}
{"kind":"ingest_draft","items":[{"type":"flight|train|hotel|sight|note|...","title":"...","place":"","city":"","date":"YYYY-MM-DD","endDate":"","start":"","end":"","from":"","to":"","notes":"","confidence":"high|medium|low","tentative":true}],"planPlaceNames":[{"name":"...","section":"must|food|maybe","city":""}],"openQuestions":[],"prefs":{},"spineOptions":[{"id":"s1","label":"...","summary":"...","areas":[{"label":"...","roughNights":2,"transportHint":"transit_ok","theme":""}],"openQuestions":[]}]}
Only include hotels the USER named in the text. Soft wants go to planPlaceNames.`,

  trip_spine: `You propose 2-3 extreme geographic spines (ordered areas only).
${SHARED_RULES}
Return: {"kind":"spine_options","options":[{"id":"s1","label":"...","summary":"...","why":"why this route fits their vibe/flights/dates","areas":[{"label":"...","roughNights":2,"transportHint":"transit_ok","theme":"","why":"why this stop"}],"openQuestions":[]}],"prefs":{}}
Or {"kind":"need_clarification","question":"..."}
Every option MUST include why that references something specific about the user (vibe, dates, existingSteps).`,

  trip_reshape: `You suggest whole-trip adjustments from a briefing + user message.
${SHARED_RULES}
Return: {"kind":"reshape","summary":"...","why":"what you heard and why this change","prefs":{},"openQuestions":[],"spineOptions":[]}
Or {"kind":"need_clarification","question":"..."}
Summary must explain what you changed and why (cite their words / existing flights).`,

  trip_enrich: `You propose optional field fills and area must-know caveats.
${SHARED_RULES}
Return: {"kind":"enrich","fieldUpdates":[{"itemTitle":"...","field":"confirm|notes|title","value":"...","confidence":"high|medium|low","source":"web|model","citation":""}],"caveats":[{"severity":"info|warn|dealbreaker","topic":"...","summary":"...","appliesTo":"area|day|leg|trip","source":"web|model"}]}
Prefer area-level caveats. Skip weak flight-number guesses. Caveat summary should say why it matters for THEIR dates/areas.`,

  trip_area_knowhow: `You brief the traveler on WHERE to base themselves in each stay-zone so they feel ready to search lodging — without inventing hotel names.
${SHARED_RULES}
For each area in the payload, explain vibe fit, 2-4 hotel/search neighborhoods (zones only), tradeoffs, and practical ready tips (walkability, transit, nightlife, booking timing).
Match tips to the user's vibe tags when provided (romantic, food, quiet, walkable, nightlife, family, etc.).
Return: {"kind":"area_knowhow","summary":"1-2 sentences on how this helps them feel ready","areas":[{"areaLabel":"...","vibeFit":"why this area fits THEIR vibe","hotelZones":[{"label":"neighborhood name","why":"why base here","forVibes":["romantic","walkable"]}],"tradeoffs":"who this area is less ideal for","readyTips":["practical tip","..."]}]}
Never invent hotel brand names. Zones = neighborhoods / districts only.`,

  trip_compose: `You compose a complete trip skeleton for a travel journal app from the user's vibe + dates.
${SHARED_RULES}
Fill every calendar day in the given startDate..endDate window with an area stay-zone (city/neighborhood), not hotels.
Respect existingSteps: prefer itemUpdates for flights/trains already on the trip; never duplicate the same leg.
CRITICAL: Explain every choice. Users feel ignored when AIs dump places with no why.
Return: {"kind":"full_trip","summary":"...","titleSuggestion":"...","spine":{"id":"s1","label":"...","summary":"...","why":"why this spine fits them","areas":[{"label":"...","roughNights":2,"transportHint":"walk_city|transit_ok|car_useful|car_needed","theme":"...","why":"why this stop"}],"openQuestions":[]},"dayPlan":[{"date":"YYYY-MM-DD","areaLabel":"...","theme":"...","why":"why THIS calendar day (arrival, birthday, rest, departure)","special":false,"highlights":[{"name":"named sight","why":"why it fits this day/user"}]}],"planPlaceNames":[{"name":"...","section":"must|food|maybe","city":"","why":"why on the list"}],"items":[{"type":"flight|train|sight|note|activity|restaurant","title":"...","place":"","city":"","date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","from":"","to":"","notes":"include why if new","confidence":"medium","source":"inferred","tentative":true}],"itemUpdates":[{"itemId":"...","start":"HH:MM","end":"HH:MM","from":"","to":"","title":"","notes":""}],"decisions":[{"what":"short label of what you added/changed","why":"1-2 sentences tying to their vibe, dates, or existing flight"}],"prefs":{"pace":"balanced","transport":"mixed"},"openQuestions":[]}
Rules: NEVER type "hotel". Soft wants → planPlaceNames. Highlights = concrete named places with why. Prefer itemUpdates when existingSteps has matching ids. decisions MUST mention existing flights/trains when present. day.why and highlight.why required.
SPECIAL DATES: If the user names a birthday, anniversary, celebration, or exact date to center on, that dayPlan row MUST have special:true, its own theme naming the occasion (e.g. "Birthday spa & dinner"), and the celebration highlights on THAT date only — do not bury it inside a generic multi-day theme for the stay-zone.
Each calendar day gets its own dayPlan entry with a day-specific theme/why even when areaLabel stays the same across nights.
Or {"kind":"need_clarification","question":"..."} when region/dates are too vague.`,

  trip_chat: `You are the Whole Trip coach for a travel journal app. Talk like a helpful human planning partner who makes the user feel seen.
${SHARED_RULES}
You do NOT ask the user to pick feature tabs. Decide the next action yourself.
In every reply: acknowledge what they said or what already exists on the trip (flights, dates, vibe) before proposing. Explain WHY you chose a tool or a change — never dump a list without rationale.
Available tools (call at most ONE per turn):
- compose_full_trip — build/rebuild a full area spine + day plan (args: {userMessage})
- propose_spines — 2-3 route alternatives (args: {userMessage})
- area_tips — neighborhood stay-zone ideas (args: {userMessage, area?})
- set_stay_zone — user chose an area tip (args: {areaLabel} or wait for UI — prefer returning draft/reply)
- enrich — must-knows / caveats for current spine areas (args: {userMessage})
- area_knowhow — hotel-search neighborhoods + vibe fit + ready tips per stay zone (args: {userMessage}) — use when they ask where to stay, which neighborhood fits their vibe, or need confidence before booking
- reshape — adjust existing trip/draft from vibe change (args: {userMessage})
- update_items — user gave flight times/airports; emit draft with itemUpdates (prefer kind draft directly)

Return ONE of:
{"kind":"reply","message":"...","modeLabel":"Listening|Sketching a route|Comparing stay zones|Filling flight details|Gathering must-knows|Reshaping the trip|Ready to apply","reason":"one short why sentence showing you heard them","checklist":{"vibe":true,"route":false,"stayZones":false,"details":false,"ready":false}}
{"kind":"tool","tool":"compose_full_trip|propose_spines|area_tips|enrich|area_knowhow|reshape|update_items","args":{},"modeLabel":"...","reason":"...","message":"optional narrate that explains why this tool"}
{"kind":"draft","message":"...","modeLabel":"Ready to apply","reason":"...","draft":{same shape as trip_compose full_trip fields including decisions/why},"checklist":{}}

Always read existingSteps. Prefer itemUpdates over new flights. Never invent hotels. modeLabel + reason + message must be human and specific to THIS trip.
When the user names a birthday/anniversary/exact date, the dayPlan for that date must stay distinct (special:true + its own theme) — never fold it into a generic multi-day stay-zone theme.
Proactively offer area_knowhow once stay zones exist if they seem unsure where to sleep or want to feel ready — briefly explain why you're fetching it.`,
}

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
  const mode = clamp(String(body.mode ?? ''), 40)
  const system = SYSTEMS[mode]
  if (!system) {
    res.status(400).json({
      error: `Unknown mode. Use: ${Object.keys(SYSTEMS).join(', ')}`,
    })
    return
  }

  const { mode: _m, ...rest } = body
  const userText = `Authoritative context (ignore chat memory):\n${JSON.stringify(rest).slice(0, 28000)}`

  const models = modelCascade()
  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.4,
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
      const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()
      try {
        const parsed = JSON.parse(cleaned) as unknown
        res.status(200).json(parsed)
        return
      } catch {
        lastError = 'Model returned non-JSON'
        if (i < models.length - 1) continue
        res.status(502).json({ error: lastError, model: usedModel, raw: cleaned.slice(0, 500) })
        return
      }
    }
    res.status(502).json({ error: lastError, model: usedModel })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Agent proxy failed',
    })
  }
}

