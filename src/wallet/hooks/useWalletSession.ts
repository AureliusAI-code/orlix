import { useEffect, useRef } from 'react'
import { useAccount } from 'wagmi'

// Syncs wagmi wallet state → localStorage + custom DOM events.
// Vanilla-JS pages listen to orlix:wallet:connected / orlix:wallet:disconnected.
export function useWalletSession() {
  const { address, isConnected, status } = useAccount()
  const prevAddr = useRef<string | undefined>(undefined)

  useEffect(() => {
    // Skip transient states — wait for settled connected / disconnected
    if (status === 'connecting' || status === 'reconnecting') return

    if (isConnected && address) {
      if (prevAddr.current === address) return
      prevAddr.current = address

      const userData = {
        id: address,
        address,
        display: `${address.slice(0, 6)}…${address.slice(-4)}`,
        type: 'wallet' as const,
      }

      try {
        localStorage.setItem('orlix_user', JSON.stringify(userData))
        localStorage.setItem('orlix_token', `wallet:${address}`)
      } catch {
        // localStorage blocked in strict private browsing
      }

      window.dispatchEvent(
        new CustomEvent('orlix:wallet:connected', {
          detail: { address, display: userData.display },
        })
      )
    } else if (status === 'disconnected') {
      if (prevAddr.current === undefined) return
      prevAddr.current = undefined

      try {
        localStorage.removeItem('orlix_user')
        localStorage.removeItem('orlix_token')
      } catch {}

      window.dispatchEvent(new CustomEvent('orlix:wallet:disconnected'))
    }
  }, [isConnected, address, status])

  // On first mount: if wagmi has already reconnected from a persisted session,
  // fire the connected event immediately so the page reflects the right state.
  useEffect(() => {
    if (status === 'connected' && address && prevAddr.current === undefined) {
      prevAddr.current = address
      const display = `${address.slice(0, 6)}…${address.slice(-4)}`
      try {
        localStorage.setItem('orlix_user', JSON.stringify({ id: address, address, display, type: 'wallet' }))
        localStorage.setItem('orlix_token', `wallet:${address}`)
      } catch {}
      window.dispatchEvent(new CustomEvent('orlix:wallet:connected', { detail: { address, display } }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
