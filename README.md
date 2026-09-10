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
- **Excel** — import / export `Trip` + `Schedule` + `Legend` sheets
- **Polarsteps bridge** — export a compatible JSON (no public Polarsteps import API)
- **PWA** — installable mobile-friendly shell
- **Example trip** — France South Loop → Napoli (Paris → TGV Marseille → Provence loop → Naples)

### Map stack

| Stack | Notes |
| --- | --- |
| Esri imagery (default) | Free satellite basemap |
| OpenStreetMap | Free street tiles |
| Google Photorealistic 3D | Optional; paste a Maps key in **Data** |
| Cesium ion terrain + OSM buildings | Optional; paste an ion token in **Data** — buildings only show when zoomed in close |

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
3. No env vars required for the free stack

Optional later: set Cesium ion / Google keys in the app’s **Data** panel (stored in IndexedDB on that browser), not as Vercel env unless you wire that yourself.

**Note:** IndexedDB is per browser/device. Deploying does not sync trips across phones unless you export/import Excel (or add your own sync later).

## Stack

- Vite + React 19 + TypeScript + Tailwind 4
- CesiumJS, SheetJS (`xlsx`), IndexedDB (`idb`), Zod, ECharts
- Nominatim / Wikidata / OSRM for enrichment and routes
- Frankfurter (ECB) for FX totals

## License

Private / personal use unless you add a license.
