import { useEffect, useRef } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'

// Syncs Privy auth state → localStorage + custom DOM events.
// Vanilla-JS pages listen to orlix:wallet:connected / orlix:wallet:disconnected.
export function useWalletSession() {
  const { ready, authenticated, user } = usePrivy()
  const { wallets } = useWallets()
  const prevAddr = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!ready) return

    const address = wallets[0]?.address ?? undefined

    if (authenticated && address) {
      if (prevAddr.current === address) return
      prevAddr.current = address

      const display  = `${address.slice(0, 6)}…${address.slice(-4)}`
      const userData = {
        id:       user?.id ?? address,
        address,
        display,
        type:     'wallet' as const,
        privy_id: user?.id,
      }

      try {
        localStorage.setItem('orlix_user',  JSON.stringify(userData))
        localStorage.setItem('orlix_token', user?.id ? `privy:${user.id}` : `wallet:${address}`)
      } catch { /* strict private browsing */ }

      window.dispatchEvent(
        new CustomEvent('orlix:wallet:connected', {
          detail: { address, display },
        })
      )
    } else if (ready && !authenticated) {
      if (prevAddr.current === undefined) return
      prevAddr.current = undefined

      try {
        localStorage.removeItem('orlix_user')
        localStorage.removeItem('orlix_token')
      } catch {}

      window.dispatchEvent(new CustomEvent('orlix:wallet:disconnected'))
    }
  }, [ready, authenticated, wallets, user])
}
