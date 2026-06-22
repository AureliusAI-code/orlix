import { useEffect, useRef } from 'react'
import { useAccount } from 'wagmi'

// Syncs wagmi wallet state to localStorage (orlix_user / orlix_token)
// and dispatches custom DOM events so vanilla-JS pages can react.
export function useWalletSession() {
  const { address, isConnected, status } = useAccount()

  // Track previous address to avoid duplicate dispatches
  const prevAddr = useRef<string | undefined>(undefined)

  useEffect(() => {
    // Skip transient states — wait for settled connected/disconnected
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
        // localStorage blocked (e.g. private browsing with strict settings)
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
}
