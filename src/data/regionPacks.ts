/** Curated country / region idea packs for Plan mode. */
export type RegionPackPlace = {
  name: string
  city: string
  lat: number
  lon: number
  section: 'Must see' | 'Food' | 'Stay ideas'
  notes?: string
}

export type RegionPack = {
  id: string
  label: string
  country: string
  places: RegionPackPlace[]
}

export const REGION_PACKS: RegionPack[] = [
  {
    id: 'provence',
    label: 'Provence highlights',
    country: 'France',
    places: [
      {
        name: 'Pont du Gard',
        city: 'Vers-Pont-du-Gard',
        lat: 43.9475,
        lon: 4.5356,
        section: 'Must see',
        notes: 'Roman aqueduct',
      },
      {
        name: 'Les Baux-de-Provence',
        city: 'Les Baux',
        lat: 43.7439,
        lon: 4.7956,
        section: 'Must see',
      },
      {
        name: 'Calanques boat',
        city: 'Cassis',
        lat: 43.214,
        lon: 5.538,
        section: 'Must see',
      },
      {
        name: 'Le Petit Nice',
        city: 'Marseille',
        lat: 43.276,
        lon: 5.351,
        section: 'Food',
        notes: 'Seafood / bouillabaisse',
      },
      {
        name: 'Café Gaby',
        city: 'Gordes',
        lat: 43.912,
        lon: 5.2,
        section: 'Food',
      },
      {
        name: 'La Bastide de Gordes',
        city: 'Gordes',
        lat: 43.9114,
        lon: 5.2003,
        section: 'Stay ideas',
      },
    ],
  },
  {
    id: 'tuscany',
    label: 'Tuscany starters',
    country: 'Italy',
    places: [
      {
        name: 'Duomo di Siena',
        city: 'Siena',
        lat: 43.3178,
        lon: 11.3291,
        section: 'Must see',
      },
      {
        name: 'Piazza del Campo',
        city: 'Siena',
        lat: 43.3186,
        lon: 11.3314,
        section: 'Must see',
      },
      {
        name: 'Osteria Le Logge',
        city: 'Siena',
        lat: 43.3182,
        lon: 11.332,
        section: 'Food',
      },
      {
        name: 'Val d’Orcia viewpoint',
        city: 'Pienza',
        lat: 43.077,
        lon: 11.678,
        section: 'Must see',
      },
    ],
  },
]

export function findRegionPack(id: string): RegionPack | undefined {
  return REGION_PACKS.find((p) => p.id === id)
}
