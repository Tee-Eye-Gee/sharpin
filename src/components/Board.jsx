import { useState, useEffect, useMemo } from 'react'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { BOARD_THEMES, DEFAULT_BOARD_THEME, accentRgba, moveIndicatorRgba } from '../utils/theme'

const STATUS_RING = {
  solved: 'ring-2 ring-emerald-500/70',
  failed: 'ring-2 ring-red-500/70',
  correct: 'ring-2 ring-accent/70',
}

const PROMOTION_PIECES = [
  { code: 'q', label: 'Queen' },
  { code: 'r', label: 'Rook' },
  { code: 'b', label: 'Bishop' },
  { code: 'n', label: 'Knight' },
]

// a1 is a dark square; standard (file + rank) parity determines the rest.
function isLightSquare(square) {
  const file = square.charCodeAt(0) - 97
  const rank = parseInt(square[1], 10)
  return (file + rank) % 2 === 0
}

// Square center in an 8x8 unit grid (viewBox="0 0 8 8"), orientation-aware.
// Using board-relative units rather than pixels means the arrow overlay
// scales automatically with the board's actual rendered size (375px vs
// 1280px) exactly like react-chessboard's own square rendering does --
// no boardWidth measurement needed.
function squareCoords(square, orientation) {
  const file = square.charCodeAt(0) - 97 // 0-7, a-h
  const rank = parseInt(square[1], 10) // 1-8
  return orientation === 'black'
    ? { x: 7 - file + 0.5, y: rank - 1 + 0.5 }
    : { x: file + 0.5, y: 8 - rank + 0.5 }
}

function pullBack(from, to, amount) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return to
  return { x: to.x - (dx / len) * amount, y: to.y - (dy / len) * amount }
}

// Intersection of infinite lines p1-p2 and p3-p4. Used by
// offsetPolygonOutward below to find each offset polygon's vertices --
// not exposed outside this module, purely a building block for it.
function lineIntersect(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y
  const denom = d1x * d2y - d1y * d2x
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom
  return { x: p1.x + t * d1x, y: p1.y + t * d1y }
}

// General-purpose outward polygon offset (Minkowski-style, miter joins):
// offsets every edge outward along its own perpendicular by `distance`,
// then re-intersects each pair of adjacent offset edges to find the new
// vertices -- this is what a true stroke-to-fill conversion does at each
// corner, so the result sits at EXACTLY `distance` from every original
// edge, all the way along it (verified by point-sampling in
// BestMoveArrowOverlay's usage below), not just at the vertices -- the
// same uniformity round 8 got from SVG's native `stroke`, but computed by
// hand so it can be baked into a second, independently-colored polygon
// instead of sharing an edge with the fill (round 12; see
// ARROW_HEAD_BORDER_WIDTH for why sharing an edge was the problem).
// Assumes a convex polygon wound so that (edge.dy, -edge.dx) points
// outward -- true for ARROWHEAD_FILL_POINTS below, checked against the
// triangle's own centroid.
function offsetPolygonOutward(points, distance) {
  const n = points.length
  const offsetEdges = points.map((p, i) => {
    const q = points[(i + 1) % n]
    const dx = q.x - p.x, dy = q.y - p.y
    const len = Math.hypot(dx, dy)
    return { p: { x: p.x + (dy / len) * distance, y: p.y - (dx / len) * distance }, dx, dy }
  })
  return points.map((_, i) => {
    const e1 = offsetEdges[(i - 1 + n) % n]
    const e2 = offsetEdges[i]
    return lineIntersect(e1.p, { x: e1.p.x + e1.dx, y: e1.p.y + e1.dy }, e2.p, { x: e2.p.x + e2.dx, y: e2.p.y + e2.dy })
  })
}

// A knight move's |delta file|,|delta rank| is always {1,2} in some order --
// the one shape on the board that customArrows' straight-line-only geometry
// can never represent correctly, since every other piece's move genuinely
// is a straight line (horizontal/vertical/diagonal).
function isKnightMove(from, to) {
  const df = Math.abs(from.charCodeAt(0) - to.charCodeAt(0))
  const dr = Math.abs(parseInt(from[1], 10) - parseInt(to[1], 10))
  return (df === 1 && dr === 2) || (df === 2 && dr === 1)
}

// Bend point for the knight's L-shaped path: horizontal leg first (stays on
// the source's rank), then vertical leg to the destination -- matches the
// worked example from investigation (c5->b7 renders as c5->b5 then b5->b7).
function knightBendSquare(from, to) {
  return `${to[0]}${from[1]}`
}

// Legal destinations from `square`, deduped across the (up to 4)
// promotion-piece move variants chess.js returns for the same from/to pair.
// Display-only: this never decides whether a move is the puzzle's correct
// solution -- that's still onUserMove's job, untouched here.
function getLegalDestinations(chess, square) {
  const destinations = new Map()
  for (const move of chess.moves({ square, verbose: true })) {
    const existing = destinations.get(move.to) ?? { isCapture: false, isPromotion: false }
    if (move.captured) existing.isCapture = true
    if (move.promotion) existing.isPromotion = true
    destinations.set(move.to, existing)
  }
  return destinations
}

export default function Board({ fen, orientation, status, lastMove, hintPieceSquare, hintDestSquare, onUserMove, boardTheme, appMode, inputMode, bestMoveArrow = null }) {
  // 'analyzing' is Analyze mode's free-play status (spec
  // Sharpin_Spec_AnalyzeMode.md §4) -- distinct from 'solving' so it never
  // silently inherits puzzle-mode gating, but treated as equally playable
  // here since both are "board accepts user input" states. STATUS_RING has
  // no 'analyzing' entry, so the solved/failed/correct ring simply doesn't
  // apply while analyzing -- no separate suppression needed.
  const isPlayable = status === 'solving' || status === 'analyzing'
  const isTapMode = inputMode === 'tap'
  const { light: lightSquare, dark: darkSquare } = BOARD_THEMES[boardTheme] ?? BOARD_THEMES[DEFAULT_BOARD_THEME]
  const highlight = accentRgba(appMode, 0.35) // accent glow on last move / selection

  // Tap-mode selection state machine (spec: Sharpin_Spec_ClickToMove.md §2).
  // Drag mode never touches either of these.
  const [selection, setSelection] = useState(null) // { square, piece } | null
  const [pendingPromotion, setPendingPromotion] = useState(null) // { from, to, color } | null

  // A puzzle transition (next puzzle, opponent auto-reply, solved/failed)
  // must not leave a stale selection or an open promotion picker behind.
  useEffect(() => {
    if (status !== 'solving') {
      setSelection(null)
      setPendingPromotion(null)
    }
  }, [status])

  const legalDestinations = useMemo(() => {
    if (!isTapMode || !selection || !fen) return new Map()
    return getLegalDestinations(new Chess(fen), selection.square)
  }, [isTapMode, selection, fen])

  // Shared commit path for both input methods -- unchanged from the
  // drag-and-drop implementation. Tap mode reaches this exact function via
  // handleSquareClick/choosePromotion instead of react-chessboard's
  // onPieceDrop; it never forks or duplicates what happens after this call.
  function handlePieceDrop(sourceSquare, targetSquare, piece) {
    if (!isPlayable) return false
    return onUserMove(sourceSquare, targetSquare, piece)
  }

  function isOwnPieceToMove(piece) {
    return !!fen && piece[0] === new Chess(fen).turn()
  }

  function handleSquareClick(square, piece) {
    if (!isPlayable || pendingPromotion) return

    if (!selection) {
      if (piece && isOwnPieceToMove(piece)) setSelection({ square, piece })
      return
    }

    if (square === selection.square) {
      setSelection(null) // tap same piece again -> deselect
      return
    }

    const destination = legalDestinations.get(square)
    if (destination) {
      if (destination.isPromotion) {
        setPendingPromotion({ from: selection.square, to: square, color: selection.piece[0] })
      } else {
        handlePieceDrop(selection.square, square, selection.piece)
        setSelection(null)
      }
      return
    }

    if (piece && isOwnPieceToMove(piece)) {
      setSelection(null) // deselect only -- user must tap the new piece again to select it
      return
    }

    setSelection(null) // illegal square -- silent deselect, no error state
  }

  function choosePromotion(pieceLetter) {
    if (!pendingPromotion) return
    const pieceCode = `${pendingPromotion.color}${pieceLetter.toUpperCase()}`
    handlePieceDrop(pendingPromotion.from, pendingPromotion.to, pieceCode)
    setPendingPromotion(null)
    setSelection(null)
  }

  const customSquareStyles = {}
  if (lastMove) {
    customSquareStyles[lastMove.from] = { backgroundColor: highlight }
    customSquareStyles[lastMove.to]   = { backgroundColor: highlight }
  }
  if (isTapMode && selection) {
    customSquareStyles[selection.square] = { backgroundColor: highlight }
    for (const [square, info] of legalDestinations) {
      const base = isLightSquare(square) ? lightSquare : darkSquare
      // A dark outline (behind the colored shape) makes these readable on
      // dark squares too, where the indicator color's own contrast is weak —
      // visibility comes from the edge, not from color-vs-square contrast.
      customSquareStyles[square] = info.isCapture
        ? { backgroundColor: base, boxShadow: `inset 0 0 0 4px ${moveIndicatorRgba(appMode, 0.55)}, inset 0 0 0 5px rgba(0, 0, 0, 0.35)` }
        : { backgroundColor: base, backgroundImage: `radial-gradient(circle, ${moveIndicatorRgba(appMode, 0.45)} 22%, transparent 24%), radial-gradient(circle, rgba(0, 0, 0, 0.35) 24%, transparent 26%)` }
    }
  }
  // Hint highlights (spec Sharpin_Spec_HintSystem.md §3), applied last so
  // they ring on top of (rather than get clobbered by) any lastMove/
  // selection background on the same square. Distinct tokens per tier
  // (moveIndicator for the piece, accent for the destination) so the two
  // are visually distinguishable, reusing existing color tokens rather than
  // adding new theme infrastructure for this feature.
  if (hintPieceSquare) {
    customSquareStyles[hintPieceSquare] = {
      ...(customSquareStyles[hintPieceSquare] ?? {}),
      boxShadow: `inset 0 0 0 4px ${moveIndicatorRgba(appMode, 0.9)}`,
    }
  }
  if (hintDestSquare) {
    customSquareStyles[hintDestSquare] = {
      ...(customSquareStyles[hintDestSquare] ?? {}),
      boxShadow: `inset 0 0 0 4px ${accentRgba(appMode, 0.9)}`,
    }
  }

  const ringClass = STATUS_RING[status] ?? ''

  return (
    <div className={`relative w-full rounded-lg transition-all ${ringClass}`}>
      {status === 'loading' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 rounded-lg pointer-events-none">
          <ThinkingDots />
        </div>
      )}

      {pendingPromotion && <PromotionPicker onSelect={choosePromotion} />}

      {fen && (
        <Chessboard
          position={fen}
          onPieceDrop={isTapMode ? undefined : handlePieceDrop}
          onSquareClick={isTapMode ? handleSquareClick : undefined}
          boardOrientation={orientation}
          arePiecesDraggable={!isTapMode && isPlayable}
          customDarkSquareStyle={{ backgroundColor: darkSquare }}
          customLightSquareStyle={{ backgroundColor: lightSquare }}
          customSquareStyles={customSquareStyles}
          animationDuration={200}
        />
      )}

      {bestMoveArrow && (
        <BestMoveArrowOverlay from={bestMoveArrow.from} to={bestMoveArrow.to} orientation={orientation} appMode={appMode} />
      )}
    </div>
  )
}

function ThinkingDots() {
  return (
    <div className="flex gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  )
}

function PromotionPicker({ onSelect }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 rounded-lg">
      <div className="flex gap-2 rounded-lg border border-border bg-surface p-3 shadow-xl">
        {PROMOTION_PIECES.map(({ code, label }) => (
          <button
            key={code}
            onClick={() => onSelect(code)}
            aria-label={`Promote to ${label}`}
            className="flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-lg border border-border
                       text-fg transition-all hover:border-accent hover:bg-accent/10 active:scale-95"
          >
            <span className="text-lg font-bold uppercase">{code}</span>
            <span className="text-[10px] text-fg-muted">{label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// Visual weights below are in the same 0-8 unit grid as squareCoords -- so
// they scale with the board automatically at any viewport, same reasoning
// as the coordinate system itself. ARROW_STROKE_WIDTH intentionally mirrors
// react-chessboard's own former customArrows weight (boardWidth/40, i.e.
// 8/40 = 0.2 units) so the line itself looks the same as before; the
// outline is new -- same "wider dark shape behind, colored shape in front"
// technique as the move-indicator circles' boxShadow rings (Board.jsx
// customSquareStyles above), just via genuine SVG stroke layering instead
// of a CSS box-shadow hack, since this is fully custom SVG now.
//
// ARROW_GAP is deliberately separate from the arrowhead's own size -- the
// prior pass conflated "how big is the arrowhead" with "how much gap is
// there before the destination" into one oversized pullback (0.6*0.85 =
// 0.51 units, 51% of a square -- confirmed via real rendered coordinates
// against two independently-verified moves), which visually stopped the
// arrow a full square short. This is applied symmetrically at BOTH ends via
// the existing pullBack() helper -- the prior pass only ever pulled back
// the end, never the start, which is why the arrow ran straight through
// the piece it started from.
// round 5: reduced from 0.11/0.17 (~18%, keeping the outline/stroke ratio
// roughly intact) alongside the arrowhead shrink below, so the line reads
// proportionally thinner rather than staying oversized next to the now-
// smaller triangle.
const ARROW_STROKE_WIDTH = 0.09
const ARROW_OUTLINE_STROKE_WIDTH = 0.14
const ARROW_GAP = 0.32 // units -- percent-of-square gap has to clear the piece ARTWORK, not just the square boundary (pieces render at ~80-90% of a square), so this sits meaningfully larger than a bare square-edge margin
// round 5: fixed size for EVERY arrow, no per-segment scaling (see
// computeArrowGeometry below) -- chosen against the worst-case segment, a
// single-square orthogonal move (length 1.0) or a knight's final leg when
// it's 1 square (same 1.0 length): ARROW_GAP is consumed at BOTH ends
// (0.32+0.32=0.64), leaving 0.36 for the arrowhead's own length. 0.28
// leaves 0.08 units (8% of a square) of visible line at that exact worst
// case, with margin below the 0.36 ceiling rather than sitting flush
// against it -- every other move shape (diagonal single-square at 1.41,
// any 2-square-or-longer straight move, any knight leg of 2) has strictly
// more room than this, so 0.28 is safe everywhere, not just at the floor.
const ARROW_HEAD_LENGTH = 0.28
const ARROW_HEAD_WIDTH = 0.28
// Visible border width for the arrowhead, matching the line's own visible
// border width: (ARROW_OUTLINE_STROKE_WIDTH - ARROW_STROKE_WIDTH) / 2 =
// 0.025, the width of the line's dark band left uncovered by its thinner
// foreground stroke (see the two shaft <path>s in BestMoveArrowOverlay).
// Getting the arrowhead to genuinely match that width AND that same 45%-
// alpha translucent weight took several rounds to land on the right
// mechanism:
//   - rounds 4/5 (two triangles, fill triangle's length/width
//     independently shrunk by a flat inset): the base edge's gap matched
//     the inset exactly, but the two slanted edges only reached ~36% of
//     that at the base corner and tapered to 0 at the tip -- shrinking a
//     triangle's dimensions by a flat amount isn't a uniform perpendicular
//     offset.
//   - round 8 (one polygon, fill + stroke straddling its own edge): fixed
//     the taper using SVG's native `stroke`, a true perpendicular offset
//     -- but a stroke straddling its own fill only reads seam-free if
//     fully opaque (the semi-transparent inner half blends with the fill
//     into a muddy color, neither fill nor border).
//   - rounds 9-11 (tuning that straddling stroke's width/opacity): going
//     opaque fixed the muddy blend, but then the visible border read as
//     the FULL strokeWidth (both straddled halves now solid and
//     indistinguishable) instead of half of it, and the arrowhead's
//     weight was permanently bolder/less translucent than the line's --
//     two side effects of the same root cause: a stroke sharing an edge
//     with its own fill can't independently control "how uniform" and
//     "how translucent" at once.
// round 12: rebuilt using the line's OWN technique instead -- two
// independently stacked pure-fill shapes (see offsetPolygonOutward above,
// used just below), with NO shared edge and NO stroke attribute on
// either shape. This keeps round 8's uniformity (every edge, including
// the diagonals, sits exactly ARROW_HEAD_BORDER_WIDTH from its outline
// counterpart -- verified by point-sampling, same method as round 8) while
// finally using the line's actual translucent outlineColor (0.45 alpha)
// as the visible border instead of an opaque stand-in -- the two goals
// stopped competing once there was no longer a shared edge for them to
// fight over.
const ARROW_HEAD_BORDER_WIDTH = (ARROW_OUTLINE_STROKE_WIDTH - ARROW_STROKE_WIDTH) / 2

// The arrowhead's two shapes, computed once at module scope -- they
// depend only on the constants above, never on a specific arrow's
// from/to/orientation (BestMoveArrowOverlay's marker rotates the whole
// thing via orient="auto" instead, same as every prior round).
// ARROWHEAD_FILL_POINTS is anchored the same way prior rounds' single
// polygon was: base at common-frame x=0 (the path's true end vertex, see
// computeArrowGeometry), tip at x=ARROW_HEAD_LENGTH.
const ARROWHEAD_FILL_POINTS = [
  { x: 0, y: -ARROW_HEAD_WIDTH / 2 },
  { x: ARROW_HEAD_LENGTH, y: 0 },
  { x: 0, y: ARROW_HEAD_WIDTH / 2 },
]
const ARROWHEAD_OUTLINE_POINTS = offsetPolygonOutward(ARROWHEAD_FILL_POINTS, ARROW_HEAD_BORDER_WIDTH)

// A <marker> clips its content to its own viewport, so the marker's local
// box has to fully contain the larger OUTLINE shape, not just the fill --
// padding is the outline shape's own bounding box, translated so its
// minimum corner sits at local (0,0). refX/refY then point back at
// wherever common-frame (0,0) (the path's true anchor) landed after that
// shift, same anchoring role refX/refY have always played here.
const ARROWHEAD_XS = ARROWHEAD_OUTLINE_POINTS.map((p) => p.x)
const ARROWHEAD_YS = ARROWHEAD_OUTLINE_POINTS.map((p) => p.y)
const ARROWHEAD_PAD_X = -Math.min(...ARROWHEAD_XS)
const ARROWHEAD_PAD_Y = -Math.min(...ARROWHEAD_YS)
const ARROWHEAD_MARKER_WIDTH = Math.max(...ARROWHEAD_XS) - Math.min(...ARROWHEAD_XS)
const ARROWHEAD_MARKER_HEIGHT = Math.max(...ARROWHEAD_YS) - Math.min(...ARROWHEAD_YS)
function toMarkerPoints(points) {
  return points.map((p) => `${p.x + ARROWHEAD_PAD_X},${p.y + ARROWHEAD_PAD_Y}`).join(' ')
}
const ARROWHEAD_FILL_MARKER_POINTS = toMarkerPoints(ARROWHEAD_FILL_POINTS)
const ARROWHEAD_OUTLINE_MARKER_POINTS = toMarkerPoints(ARROWHEAD_OUTLINE_POINTS)

// Computes the actual rendered line points for one arrow, from the raw
// square-center points, pulling ARROW_GAP back from both ends (piece
// artwork clearance) and ARROW_HEAD_LENGTH back from the destination end on
// top of that (so the visible line stops at the arrowhead's hidden base,
// not under the triangle). No per-segment scaling here (round 4's clamp is
// gone) -- every arrow uses the exact same fixed ARROW_HEAD_LENGTH/WIDTH,
// safe on every real move shape per the worst-case math above.
function computeArrowGeometry(rawPoints) {
  const n = rawPoints.length
  const gappedStart = pullBack(rawPoints[1], rawPoints[0], ARROW_GAP)
  const gappedEnd = pullBack(rawPoints[n - 2], rawPoints[n - 1], ARROW_GAP)
  const middle = rawPoints.slice(1, n - 1) // knight bend vertex, if any -- untouched
  const gapped = [gappedStart, ...middle, gappedEnd]

  const lastIdx = gapped.length - 1
  const strokeEndPoint = pullBack(gapped[lastIdx - 1], gapped[lastIdx], ARROW_HEAD_LENGTH)
  return [...gapped.slice(0, lastIdx), strokeEndPoint]
}

function pointsToPathD(points) {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`).join(' ')
}

// Best-move arrow, always PV1 only (spec: lines are read-only reference
// info, arrow never follows anything else). A single <path> is used for
// both the straight-line case (2 points) and the knight-bend case (3
// points, with an internal vertex at knightBendSquare) -- one continuous
// stroke with stroke-linejoin="round" produces a smooth rounded joint at
// the bend, which two independently-capped <line> elements could not (each
// line's own stroke-linecap="round" only rounds its own true endpoints;
// stroke-linejoin has no effect between separate elements, so the old
// two-line approach showed two overlapping end-cap bulges at the bend
// instead of one clean corner). marker-end (not marker-mid) means the
// single arrowhead lands only at the true destination regardless of how
// many vertices the path has -- customArrows itself genuinely cannot
// express a bent path at all (every array entry gets its own arrowhead),
// which is why this is fully custom SVG for every piece now, straight-line
// and bent-line cases sharing the exact same rendering path.
function BestMoveArrowOverlay({ from, to, orientation, appMode }) {
  const color = accentRgba(appMode, 0.9)
  const outlineColor = 'rgba(0, 0, 0, 0.45)'
  const knight = isKnightMove(from, to)

  const fromCoords = squareCoords(from, orientation)
  const toCoords = squareCoords(to, orientation)

  const rawPoints = knight
    ? [fromCoords, squareCoords(knightBendSquare(from, to), orientation), toCoords]
    : [fromCoords, toCoords]

  // The arrowhead's polygons are anchored by their BASE (refX/refY on the
  // marker below), not their tip, so the tip extends FORWARD from this
  // vertex to reach the true gapped destination point -- this keeps the
  // visible line stopping cleanly at the arrowhead's base (fully hidden
  // under the shapes' wide end) while the tip still lands exactly where
  // the gap places it. ARROW_HEAD_LENGTH/WIDTH are used directly
  // (round 5) -- every arrow gets the identical fixed size now, no
  // per-segment scaling.
  const strokePoints = computeArrowGeometry(rawPoints)
  const d = pointsToPathD(strokePoints)

  return (
    <svg viewBox="0 0 8 8" className="absolute inset-0 w-full h-full pointer-events-none z-10">
      <defs>
        {/* Two pure-fill polygons (round 12), the line's own technique
            applied to the arrowhead -- see ARROW_HEAD_BORDER_WIDTH above
            for why. No stroke attribute on either: the outline shape's own
            fill IS the visible border, using outlineColor at its real
            0.45 alpha (matching the line's own translucent border, not an
            opaque stand-in), and the fill shape on top uses `color`
            directly -- the exact same value the line's foreground stroke
            uses, byte-identical, not independently re-derived. */}
        <marker
          id="bestmove-head" markerUnits="userSpaceOnUse"
          markerWidth={ARROWHEAD_MARKER_WIDTH} markerHeight={ARROWHEAD_MARKER_HEIGHT}
          refX={ARROWHEAD_PAD_X} refY={ARROWHEAD_PAD_Y} orient="auto"
        >
          <polygon points={ARROWHEAD_OUTLINE_MARKER_POINTS} fill={outlineColor} />
          <polygon points={ARROWHEAD_FILL_MARKER_POINTS} fill={color} />
        </marker>
      </defs>
      {/* Dark background path still draws the shaft's own border (matching
          the line's two-stroke technique) -- it no longer carries a marker
          of its own; the single arrowhead marker on the foreground path
          below renders on top of this path's round end-cap, fully covering
          it (ARROW_HEAD_WIDTH is always wider than ARROW_OUTLINE_STROKE_WIDTH),
          so there's no gap where the old outline marker used to be. */}
      <path
        d={d} fill="none"
        stroke={outlineColor} strokeWidth={ARROW_OUTLINE_STROKE_WIDTH}
        strokeLinecap="round" strokeLinejoin="round"
      />
      <path
        d={d} fill="none"
        stroke={color} strokeWidth={ARROW_STROKE_WIDTH}
        strokeLinecap="round" strokeLinejoin="round"
        markerEnd="url(#bestmove-head)"
      />
    </svg>
  )
}
