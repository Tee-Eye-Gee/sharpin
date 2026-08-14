import { useRef, useEffect, useCallback } from 'react'
import { createStockfishClient } from '../utils/stockfishClient'

/**
 * Thin React wrapper around stockfishClient. Lazy by construction: creating
 * the client itself costs nothing (no Worker yet), and the client only
 * instantiates its Worker on the first search() call -- so calling this
 * hook unconditionally does not add to puzzle-solving cold-start time
 * (spec §7).
 *
 * Deliberately render-agnostic -- this hook does not subscribe the engine's
 * updates into React state itself. It hands back the client's subscribe/
 * getSnapshot pair as-is so the UI layer can wire them to a
 * requestAnimationFrame-throttled flush (locked render-batching pattern),
 * rather than this hook forcing a re-render on every raw `info` line.
 */
export function useStockfishEngine({ multiPv = 3 } = {}) {
  const clientRef = useRef(null)
  if (!clientRef.current) {
    clientRef.current = createStockfishClient({ multiPv })
  }

  useEffect(() => {
    const client = clientRef.current
    return () => client.terminate()
  }, [])

  const search = useCallback((request) => clientRef.current.search(request), [])
  const subscribe = useCallback((listener) => clientRef.current.subscribe(listener), [])
  const getSnapshot = useCallback(() => clientRef.current.getSnapshot(), [])
  const terminate = useCallback(() => clientRef.current.terminate(), [])

  return { search, subscribe, getSnapshot, terminate }
}
