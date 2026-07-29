// Human-readable labels for the Lichess puzzle theme tags we display most.
// Anything not listed falls back to a camelCase -> "Title Case" split.
const THEME_LABELS = {
  mateIn1: 'Mate in 1',
  mateIn2: 'Mate in 2',
  mateIn3: 'Mate in 3',
  mateIn4: 'Mate in 4',
  mateIn5: 'Mate in 5',
  hangingPiece: 'Hanging piece',
  crushing: 'Crushing',
  advantage: 'Advantage',
  fork: 'Fork',
  pin: 'Pin',
  skewer: 'Skewer',
  endgame: 'Endgame',
  middlegame: 'Middlegame',
  opening: 'Opening',
  backRankMate: 'Back-rank mate',
  discoveredAttack: 'Discovered attack',
  deflection: 'Deflection',
  intermezzo: 'Intermezzo',
  sacrifice: 'Sacrifice',
  attraction: 'Attraction',
  clearance: 'Clearance',
  interference: 'Interference',
  quietMove: 'Quiet move',
  trappedPiece: 'Trapped piece',
  xRayAttack: 'X-ray attack',
  zugzwang: 'Zugzwang',
  promotion: 'Promotion',
  underPromotion: 'Underpromotion',
  advancedPawn: 'Advanced pawn',
  capturingDefender: 'Capturing the defender',
  doubleCheck: 'Double check',
  exposedKing: 'Exposed king',
}

export function formatTheme(theme) {
  return THEME_LABELS[theme] ?? theme.replace(/([a-z])([A-Z])/g, '$1 $2')
}
