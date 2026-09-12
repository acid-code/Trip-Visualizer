import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exampleItems, exampleMeta, EXAMPLE_TRIP_ID } from '../src/data/examples/france-south-loop'
import {
  buildTripWorkbook,
  parseTripWorkbook,
  tripToBlankTemplate,
  workbookToArrayBuffer,
} from '../src/data/excel'

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

async function main() {
  const exampleWb = buildTripWorkbook(exampleTrip)
  const exampleBuf = Buffer.from(await workbookToArrayBuffer(exampleWb))
  writeFileSync(join(examplesDir, 'france-south-loop.xlsx'), exampleBuf)

  const templateWb = tripToBlankTemplate()
  const templateBuf = Buffer.from(await workbookToArrayBuffer(templateWb))
  writeFileSync(join(root, 'public', 'trip-template.xlsx'), templateBuf)

  writeFileSync(
    join(root, 'src', 'data', 'examples', 'france-south-loop.json'),
    JSON.stringify({ meta: exampleMeta, items: exampleItems }, null, 2),
  )

  const parsed = parseTripWorkbook(
    exampleBuf.buffer.slice(exampleBuf.byteOffset, exampleBuf.byteOffset + exampleBuf.byteLength),
  )
  if (parsed.meta.name !== exampleMeta.name) {
    throw new Error(`Round-trip meta name mismatch: ${parsed.meta.name}`)
  }
  if (parsed.items.length < 1) {
    throw new Error('Round-trip produced no items')
  }
  console.log(
    `Wrote public/examples/france-south-loop.xlsx, public/trip-template.xlsx, and JSON (${parsed.items.length} items re-imported)`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
