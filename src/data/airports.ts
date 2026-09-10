/** Minimal OurAirports-style IATA lookup for common demo + enrichment fallback. */
export const AIRPORTS: Record<string, { name: string; lat: number; lon: number; city: string }> = {
  TLV: { name: 'Ben Gurion', lat: 32.0114, lon: 34.8867, city: 'Tel Aviv' },
  CDG: { name: 'Charles de Gaulle', lat: 49.0097, lon: 2.5479, city: 'Paris' },
  ORY: { name: 'Orly', lat: 48.7233, lon: 2.3794, city: 'Paris' },
  MRS: { name: 'Marseille Provence', lat: 43.4393, lon: 5.2214, city: 'Marseille' },
  NAP: { name: 'Naples International', lat: 40.884, lon: 14.2908, city: 'Naples' },
  FCO: { name: 'Fiumicino', lat: 41.8003, lon: 12.2389, city: 'Rome' },
  LHR: { name: 'Heathrow', lat: 51.47, lon: -0.4543, city: 'London' },
  JFK: { name: 'John F Kennedy', lat: 40.6413, lon: -73.7781, city: 'New York' },
  AMS: { name: 'Schiphol', lat: 52.3105, lon: 4.7683, city: 'Amsterdam' },
  BCN: { name: 'El Prat', lat: 41.2974, lon: 2.0833, city: 'Barcelona' },
  MAD: { name: 'Barajas', lat: 40.4983, lon: -3.5676, city: 'Madrid' },
  ATH: { name: 'Eleftherios Venizelos', lat: 37.9364, lon: 23.9445, city: 'Athens' },
  MXP: { name: 'Malpensa', lat: 45.63, lon: 8.7231, city: 'Milan' },
  NCE: { name: 'Nice Côte d’Azur', lat: 43.6584, lon: 7.2159, city: 'Nice' },
  LYS: { name: 'Lyon-Saint-Exupéry', lat: 45.7256, lon: 5.0811, city: 'Lyon' },
}

export function lookupAirport(code: string) {
  const key = code.trim().toUpperCase()
  return AIRPORTS[key]
}
