import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'
import { exampleItems, exampleMeta } from '../src/data/examples/france-south-loop'
import { buildTripWorkbook, tripToBlankTemplate } from '../src/data/excel'
import { EXAMPLE_TRIP_ID } from '../src/data/examples/france-south-loop'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const examplesDir = join(root, 'public', 'examples')
mkdirSync(examplesDir, { recursive: true })

const exampleTrip = {
  id: EXAMPLE_TRIP_ID,
  meta: exampleMeta,
  items: exampleItems,
  isExample: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const exampleWb = buildTripWorkbook(exampleTrip)
XLSX.writeFile(exampleWb, join(examplesDir, 'france-south-loop.xlsx'))

const templateWb = tripToBlankTemplate()
XLSX.writeFile(templateWb, join(root, 'public', 'trip-template.xlsx'))

writeFileSync(
  join(root, 'src', 'data', 'examples', 'france-south-loop.json'),
  JSON.stringify({ meta: exampleMeta, items: exampleItems }, null, 2),
)

console.log('Wrote public/examples/france-south-loop.xlsx, public/trip-template.xlsx, and JSON')
