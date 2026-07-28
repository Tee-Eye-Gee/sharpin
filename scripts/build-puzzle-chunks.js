// Streams the local Lichess puzzle CSV (data/raw/lichess_db_puzzle.csv, CC0,
// gitignored — too large for git) and writes one JSON chunk per 200-point
// rating band to src/data/puzzles/. Never downloads or decompresses anything
// itself; that's the GitHub Action's job (see .github/workflows/refresh-puzzles.yml).
//
// Each band is capped at CAP_PER_BAND puzzles, kept via a min-heap ranked by
// Popularity (then NbPlays as a tiebreaker) so every chunk stays mobile-sized
// (~a few hundred KB) instead of the ~800k-row files some bands would produce
// unfiltered. This trims volume for file-size reasons only — no theme is
// dropped or filtered out; all 100+ theme tags on kept puzzles are preserved.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CSV_PATH = path.join(__dirname, '../data/raw/lichess_db_puzzle.csv')
const OUT_DIR = path.join(__dirname, '../src/data/puzzles')

const BAND_SIZE = 200
const MIN_BAND = 200
const MAX_BAND = 3200
const CAP_PER_BAND = 2500

// Small binary min-heap so we can keep the top-N puzzles per band in a
// single streaming pass without ever holding a full band (up to ~880k rows)
// in memory at once.
class MinHeap {
  constructor() { this.items = [] }
  get size() { return this.items.length }
  peek() { return this.items[0] }

  push(item) {
    this.items.push(item)
    this._bubbleUp(this.items.length - 1)
  }

  replaceRoot(item) {
    this.items[0] = item
    this._bubbleDown(0)
  }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.items[parent].quality <= this.items[i].quality) break
      ;[this.items[parent], this.items[i]] = [this.items[i], this.items[parent]]
      i = parent
    }
  }

  _bubbleDown(i) {
    const n = this.items.length
    while (true) {
      const l = i * 2 + 1
      const r = i * 2 + 2
      let smallest = i
      if (l < n && this.items[l].quality < this.items[smallest].quality) smallest = l
      if (r < n && this.items[r].quality < this.items[smallest].quality) smallest = r
      if (smallest === i) break
      ;[this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]]
      i = smallest
    }
  }
}

function bandMinFor(rating) {
  const clamped = Math.min(MAX_BAND, Math.max(MIN_BAND, rating))
  return Math.floor(clamped / BAND_SIZE) * BAND_SIZE
}

function toPuzzleRecord(parts, col, rating) {
  return {
    id: parts[col.PuzzleId],
    fen: parts[col.FEN],
    moves: parts[col.Moves].split(' '),
    rating,
    themes: parts[col.Themes].split(' ').filter(Boolean),
  }
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV not found at ${CSV_PATH}`)
    console.error('Expected the decompressed Lichess puzzle database at that path — see README/spec.')
    process.exit(1)
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const heaps = new Map() // bandMin -> MinHeap
  const rl = readline.createInterface({
    input: fs.createReadStream(CSV_PATH),
    crlfDelay: Infinity,
  })

  let header = null
  let col = {}
  let rowCount = 0

  for await (const line of rl) {
    if (!header) {
      header = line.split(',')
      header.forEach((name, i) => { col[name] = i })
      continue
    }
    if (!line) continue
    rowCount++

    const parts = line.split(',')
    const rating = parseInt(parts[col.Rating], 10)
    if (Number.isNaN(rating)) continue
    const popularity = parseInt(parts[col.Popularity], 10) || 0
    const nbPlays = parseInt(parts[col.NbPlays], 10) || 0
    const quality = popularity * 1_000_000 + Math.min(nbPlays, 999_999)

    const bandMin = bandMinFor(rating)
    let heap = heaps.get(bandMin)
    if (!heap) { heap = new MinHeap(); heaps.set(bandMin, heap) }

    if (heap.size < CAP_PER_BAND) {
      heap.push({ quality, puzzle: toPuzzleRecord(parts, col, rating) })
    } else if (quality > heap.peek().quality) {
      heap.replaceRoot({ quality, puzzle: toPuzzleRecord(parts, col, rating) })
    }

    if (rowCount % 500_000 === 0) {
      console.log(`...${rowCount.toLocaleString()} rows processed`)
    }
  }

  console.log(`Parsed ${rowCount.toLocaleString()} rows across ${heaps.size} rating bands.`)

  let totalWritten = 0
  const bandMins = [...heaps.keys()].sort((a, b) => a - b)
  for (const bandMin of bandMins) {
    const heap = heaps.get(bandMin)
    const puzzles = heap.items.map((entry) => entry.puzzle)
    const file = `${bandMin}-${bandMin + BAND_SIZE - 1}.json`
    fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(puzzles))
    totalWritten += puzzles.length
    console.log(`  ${file}: ${puzzles.length} puzzles`)
  }

  console.log(`Wrote ${totalWritten.toLocaleString()} puzzles across ${bandMins.length} chunk files to ${OUT_DIR}`)
}

main()
