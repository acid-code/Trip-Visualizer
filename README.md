# Trip Tracker

Personal, local-first trip journal with a Cesium globe, schedule-first Excel round-trip, and a Google Maps–style sidebar. Data stays in your browser (IndexedDB) — no account required.

## Quick start

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

```bash
npm run build    # production build → dist/
npm run preview  # serve the build locally
npm run gen:excel  # regenerate sample France South Loop .xlsx
```

## Features

- **Globe** — Cesium orbital → street-level view; pins, drive/walk paths, day colors
- **Sidebar** — book-tongue tabs: Steps, Stats, Insert (**+**), Data
- **Detail / Insert** — bottom sheet when you select a step or add one
- **Day bases** — each day starts with a hotel/arrival slot (empty placeholders when needed)
- **Auto geocode** — paste an address or Maps link on Add/Import; lat/lon filled automatically
- **Spend** — per-step currency (EUR / USD / ILS…); Stats convert into your home currency (ECB rates)
- **Excel** — import / export Trip + Steps + Hotels + Cash sheets
- **Google Drive** — save / load trip workbooks from a Drive folder
- **PWA** — installable mobile-friendly shell
- **Example trip** — France South Loop → Napoli (Paris → TGV Marseille → Provence loop → Naples)

### Map stack

| Stack | Notes |
| --- | --- |
| Esri imagery (default) | Free satellite basemap |
| OpenStreetMap | Free street tiles |
| Google Photorealistic 3D | Optional; paste a Maps key in **Data** |
| Cesium ion terrain | Optional; paste an ion token in **Data** for elevation |

Touch (phone): one-finger pan, two-finger pinch zoom + tilt.

## Using the app

1. Open the example trip or create a blank one from **Data**
2. **Steps** — scroll the timeline; **+ Day** extends the trip; trash icon deletes a step (with confirm)
3. **+** tongue or insert-between — add a step (name, date, address, optional price)
4. Tap a pin or step — Detail sheet opens to edit
5. **Stats** — spend totals in your home currency (e.g. ILS), charts, distances
6. **Data** — Excel import/export, enrich, rebuild routes, map keys, trip dates

Empty trailing days are removed after deletes; empty middle days keep only a day-base placeholder if later days still have steps.

## Excel workflow

1. Download blank template or example `.xlsx` from **Data**
2. Edit the `Schedule` sheet (one row = one event)
3. Import back — places without lat/lon are looked up automatically when an address is present
4. Edit on device, export again (ids + coordinates preserved)

All times are **local wall clock**.

## Deploy on Vercel

The repo includes `vercel.json` (SPA rewrite + asset caching).

1. Push to GitHub and import the project on [Vercel](https://vercel.com)
2. Framework: Vite · Build: `npm run build` · Output: `dist`
3. Set env vars as needed (see `.env.example`): `GOOGLE_MAPS_API_KEY`, optional `GEMINI_API_KEY`, `VITE_GOOGLE_OAUTH_CLIENT_ID`, and for couple sharing the `VITE_FIREBASE_*` keys

Optional: set Cesium ion / Google keys in the app’s **Data** panel (stored in IndexedDB on that browser).

**Note:** IndexedDB is per browser/device. Couple sharing (below) syncs full trips (Journey + Plan) via Firestore when enabled.

## Couple sharing (Firebase)

Invite-only near-live sync for two Google accounts.

1. Create a Firebase project (Spark free tier is enough).
2. Enable **Authentication → Google** and add your Vercel/`localhost` domain under Authorized domains.
3. Create **Firestore** (production mode).
4. **Publish security rules (required before Enable sharing works):**
   - Open [Firestore Rules](https://console.firebase.google.com/project/triptracker-11e7e/firestore/rules) (replace project id if different)
   - Paste the contents of `firestore.rules` from this repo
   - Click **Publish**
   - Or CLI: `npx firebase deploy --only firestore:rules`
5. Register a Web app; copy config into Vercel / `.env.local` as `VITE_FIREBASE_*`.
6. In the app: **Settings → Share trip → Sign in with Google → Enable sharing → Invite** partner’s email.
7. Partner signs in with **that** Google account and taps **Join**. Sync includes Journey steps and Plan lists/days/POIs. No public links.
8. **Re-publish rules** whenever `firestore.rules` changes in the repo (revokes, leave, and delete rely on the latest rules).

**Delete / leave:** Owner delete removes the cloud trip for everyone. Partner delete (or **Leave shared trip**) drops their membership and keeps a local copy. **Stop sharing** revokes all editors and pending invites.

Drive Excel remains a personal backup (full-fidelity notes/confirmations) — prefer shared sync for the couple workspace.

## Security (OWASP WSTG–aligned)

| Control | How it’s handled |
| --- | --- |
| **WSTG-INPV** | Zod allowlist schemas on trip meta/items/plan; Excel rows sanitized; size/row caps; https-only media URLs |
| **WSTG-ATHN/ATHZ** | Local trips stay in IndexedDB. Shared trips require verified Google email on an invite allowlist; Firestore rules enforce owner/member access; revoke clears cloud access |
| **WSTG-CRYP** | No hardcoded API keys; optional Maps/Ion tokens are password-masked and stored locally only |
| **WSTG-ERRH** | Generic UI errors; detailed logs only in local client log (secrets redacted) |
| **WSTG-CONF** | Vercel headers: CSP (incl. Firebase endpoints), HSTS, `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy |

## Stack

- Vite + React 19 + TypeScript + Tailwind 4
- CesiumJS, SheetJS (`xlsx`), IndexedDB (`idb`), Zod, ECharts, Firebase Auth + Firestore
- Nominatim / Wikidata / OSRM for enrichment and routes
- Frankfurter (ECB) for FX totals
- Vitest unit tests; GitHub Actions (`.github/workflows/ci.yml`) runs `npm test`, `tsc`, and production build on push/PR

## License

Private / personal use unless you add a license.
