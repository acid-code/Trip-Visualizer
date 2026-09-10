# Trip Tracker

Personal, local-first trip tracker with **Schedule-first Excel** round-trip and a **CesiumJS** globe (orbital → building scale).

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Features

- Built-in example: **France South Loop → Napoli** (Paris → TGV Marseille → Provence car loop → flight to Naples)
- Excel import / export (`Trip` + `Schedule` + `Legend` sheets)
- Mobile-friendly PWA shell with timeline, charts, and pin editor
- Free map stack by default (Esri imagery + Re:Earth 3D buildings)
- Optional Google Photorealistic 3D Tiles (paste Maps key in Data tab)
- Enrichment via Nominatim, Wikidata, OSRM, and bundled airport codes

## Excel workflow

1. Download blank template or example `.xlsx` from the **Data** tab
2. Edit the `Schedule` sheet (one row per event)
3. Import back into the app
4. Edit on device, then export again (ids + lat/lon preserved)

All times are **local wall clock**.
