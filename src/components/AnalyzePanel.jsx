import Board from './Board'
import { useAnalyzeMode } from '../hooks/useAnalyzeMode'

// Mate is always unsigned ("M3", never "M-3"/"M+3") -- which side delivers
// it is communicated separately (the bar's overlay position, the list's
// swatch below), not by a sign on the number itself. Eval (cp) formatting
// is untouched -- still signed White-relative pawns.
function formatScore(scoreType, scoreValue) {
  if (scoreType == null || scoreValue == null) return '…'
  if (scoreType === 'mate') return `M${Math.abs(scoreValue)}`
  const pawns = scoreValue / 100
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}`
}

// Which color delivers a MATE score -- shared by the bar overlay and the
// list swatch (round 8) so there's exactly one sign-check in the codebase,
// not two independently-maintained copies. scoreValue is already
// White-relative by the time it reaches here (useAnalyzeMode.js's
// normalizeScore), so its raw sign is sufficient on its own -- positive
// always means White, regardless of whose move it currently is.
// Deliberately NOT blackToMove-based: a White-to-move position can still
// have Black delivering the forced mate (White's best available line is a
// losing one), which a blackToMove check would get backwards (confirmed
// against that exact case in the round-7 investigation).
function mateDeliveredBy(scoreValue) {
  return scoreValue > 0 ? 'white' : 'black'
}

// Eval magnitude (in pawns) at which the advantage bar treats a side as
// "fully" favored -- a tunable visual curve, not a locked value.
const ADVANTAGE_BAR_MAX_PAWNS = 8

// Percent of the bar that should read as White's share. Mate is a fixed
// category, not a point on the centipawn scale -- fill fully toward
// whichever side has the forced mate rather than trying to plot it.
function advantageBarWhitePercent(topScore) {
  if (topScore.scoreType === 'mate') return topScore.scoreValue > 0 ? 100 : 0
  if (topScore.scoreType == null || topScore.scoreValue == null) return 50
  const pawns = topScore.scoreValue / 100
  const clamped = Math.max(-ADVANTAGE_BAR_MAX_PAWNS, Math.min(ADVANTAGE_BAR_MAX_PAWNS, pawns))
  return 50 + (50 * clamped) / ADVANTAGE_BAR_MAX_PAWNS
}

const NAV_BUTTON_CLASS = `flex-1 rounded-lg py-2.5 font-semibold text-sm tracking-wide transition-all
                           border border-accent/40 text-accent hover:bg-accent/10 active:scale-95
                           disabled:opacity-40 disabled:pointer-events-none`

/**
 * Post-solve free-exploration sandbox (spec docs/specs/Sharpin_Spec_AnalyzeMode.md).
 * Replaces the normal puzzle-solving board+controls layout while open --
 * see App.jsx's analyzeMode branch. All state here is owned by
 * useAnalyzeMode and is fully local/ephemeral; unmounting this component
 * (Exit) is the entire cleanup story, per spec §5 -- no IndexedDB access
 * anywhere in this file or its hook.
 */
export default function AnalyzePanel({ startFen, orientation, boardTheme, appMode, inputMode, onExit }) {
  const {
    fen,
    lastMove,
    lines,
    depth,
    bestMoveArrow,
    topScore,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    onUserMove,
  } = useAnalyzeMode(startFen)

  const whitePercent = advantageBarWhitePercent(topScore)
  // round 9: the overlay is now the ONLY rendering path for every score,
  // mate or eval -- there is no external fallback span left. Single rule:
  // left/black by default, always, for every score type and sign; the
  // ONE exception is a mate Black delivers, which flips it to right/white.
  // mateDeliveredBy only matters in the mate branch here -- for eval scores
  // (any sign) or no score yet, isBlackDeliveredMate is simply false and
  // the tag stays at its default left/black, regardless of scoreValue's
  // sign (an eval score never triggers the flip, only a Black mate does).
  const isBlackDeliveredMate =
    topScore.scoreType === 'mate' &&
    topScore.scoreValue != null &&
    mateDeliveredBy(topScore.scoreValue) === 'black'

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Advantage bar -- live, updates with every rAF-batched snapshot
          flush same as the eval lines below (no separate polling/state).
          Score label reuses formatScore (same M-format/pawns convention as
          the move-list lines) and topScore (same value driving the bar's
          own fill) -- no new data plumbing. Every score (mate AND eval) is
          overlaid INSIDE the bar itself now, not a separate sibling span --
          left edge/black text by default, right edge/white text only for a
          Black-delivered mate. h-5 (up from h-2.5) so longer eval text
          like "-6.23" has room; a bare "M2" would have fit the old height,
          but eval text is the common case now that this isn't mate-only. */}
      <div className="relative h-5 rounded-full overflow-hidden bg-black/80 border border-white/20">
        <div
          className="h-full bg-white transition-[width] duration-300 ease-out"
          style={{ width: `${whitePercent}%` }}
        />
        <span
          className={`absolute inset-y-0 flex items-center px-2 text-[11px] font-mono font-bold tabular-nums ${
            isBlackDeliveredMate ? 'right-0 text-white' : 'left-0 text-black'
          }`}
        >
          {formatScore(topScore.scoreType, topScore.scoreValue)}
        </span>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">Analyze</h2>
        <button
          onClick={onExit}
          className="text-xs font-medium px-3 py-1.5 rounded-full border border-border text-fg-muted
                     hover:border-border-strong hover:text-fg transition-all"
        >
          Exit
        </button>
      </div>

      <div className="flex flex-col md:flex-row gap-4">
        <div className="flex flex-col gap-3 w-full md:max-w-[520px]">
          <Board
            fen={fen}
            orientation={orientation}
            status="analyzing"
            lastMove={lastMove}
            hintPieceSquare={null}
            hintDestSquare={null}
            onUserMove={onUserMove}
            boardTheme={boardTheme}
            appMode={appMode}
            inputMode={inputMode}
            bestMoveArrow={bestMoveArrow}
          />

          <div className="flex gap-2">
            <button onClick={goBack} disabled={!canGoBack} className={NAV_BUTTON_CLASS}>
              Back
            </button>
            <button onClick={goForward} disabled={!canGoForward} className={NAV_BUTTON_CLASS}>
              Forward
            </button>
          </div>
        </div>

        <div className="w-full md:w-72 flex-shrink-0">
          <div className="bg-surface border border-border rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs text-fg-muted uppercase tracking-widest font-medium">
                Analysis
              </h3>
              {depth > 0 && (
                <span className="text-[11px] font-mono text-fg-muted">depth {depth}</span>
              )}
            </div>

            {lines.length === 0 ? (
              <p className="text-xs text-fg-muted">Analyzing…</p>
            ) : (
              // Read-only reference info (spec §4) -- deliberately no
              // onClick/hover-as-selection anywhere in this list. Do not add
              // tap-to-jump here; that behavior was explicitly decided
              // against. Display order is mate-lines-first (see
              // useAnalyzeMode's compareLinesForDisplay) -- independent of
              // each line's actual MultiPV slot.
              <ul className="flex flex-col gap-2">
                {lines.map((line) => {
                  const isMate = line.scoreType === 'mate'
                  // Sign BEFORE formatScore's Math.abs() strips it --
                  // mateDeliveredBy is the same shared helper the bar
                  // overlay uses (round 8), so this and the bar can never
                  // drift into disagreeing sign checks.
                  const mateSide = isMate ? mateDeliveredBy(line.scoreValue) : null
                  return (
                    <li key={line.multipv} className="flex items-baseline gap-2 text-sm">
                      <span className="w-14 flex-shrink-0 flex items-center gap-1.5">
                        {isMate ? (
                          <>
                            <span
                              aria-hidden="true"
                              className={`h-2.5 w-2.5 flex-shrink-0 rounded-sm border ${
                                mateSide === 'white' ? 'bg-white border-black/30' : 'bg-black border-white/40'
                              }`}
                            />
                            <span className="font-mono font-semibold text-accent">
                              {formatScore(line.scoreType, line.scoreValue)}
                            </span>
                          </>
                        ) : (
                          // Thin border marks eval numbers as White's-
                          // perspective (mate lines get the swatch above
                          // instead -- mutually exclusive per line).
                          <span className="font-mono font-semibold text-accent rounded border border-white/40 px-1.5 py-0.5 leading-none">
                            {formatScore(line.scoreType, line.scoreValue)}
                          </span>
                        )}
                      </span>
                      <span className="text-fg-muted text-xs leading-snug">
                        {line.sans.join(' ')}
                        {line.truncated ? '…' : ''}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
