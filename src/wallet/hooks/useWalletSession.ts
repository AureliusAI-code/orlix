import { useEffect, useRef, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'

// After a wallet connects, we run Privy SIWE so the session is a real Privy JWT.
// Falls back to a local wallet:{address} token if the user rejects signing or
// the auth endpoint is unavailable — the app stays functional either way.
export function useWalletSession() {
  const { address, isConnected, status } = useAccount()
  const { signMessageAsync }             = useSignMessage()
  const prevAddr                         = useRef<string | undefined>(undefined)
  const [signing, setSigning]            = useState(false)

  async function authenticate(addr: string) {
    setSigning(true)
    try {
      // 1. Request SIWE message from Privy via server proxy
      const initRes = await fetch('/api/auth', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'siwe-init', address: addr }),
      })
      if (!initRes.ok) throw new Error('siwe-init failed')
      const { message } = await initRes.json()

      // 2. Ask wallet to sign the message
      const signature = await signMessageAsync({ message })

      // 3. Exchange signature for Privy JWT
      const authRes = await fetch('/api/auth', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'siwe-authenticate', message, signature, chainId: 8453 }),
      })
      if (!authRes.ok) throw new Error('siwe-authenticate failed')
      const { token, user } = await authRes.json()

      const display  = `${addr.slice(0, 6)}…${addr.slice(-4)}`
      const userData = {
        id:       user?.id || addr,
        address:  addr,
        display,
        type:     'wallet' as const,
        privy_id: user?.id,
      }
      localStorage.setItem('orlix_user',  JSON.stringify(userData))
      localStorage.setItem('orlix_token', token)
      return userData
    } catch {
      // Wallet rejected signing or server unreachable — local session only
      const display  = `${addr.slice(0, 6)}…${addr.slice(-4)}`
      const userData = { id: addr, address: addr, display, type: 'wallet' as const }
      try {
        localStorage.setItem('orlix_user',  JSON.stringify(userData))
        localStorage.setItem('orlix_token', `wallet:${addr}`)
      } catch { /* strict private browsing */ }
      return userData
    } finally {
      setSigning(false)
    }
  }

  // ── React to connect / disconnect ────────────────────────────────────────────
  useEffect(() => {
    if (status === 'connecting' || status === 'reconnecting') return

    if (isConnected && address) {
      if (prevAddr.current === address) return
      prevAddr.current = address

      authenticate(address).then(userData => {
        window.dispatchEvent(
          new CustomEvent('orlix:wallet:connected', {
            detail: { address, display: userData.display },
          })
        )
      })
    } else if (status === 'disconnected') {
      if (prevAddr.current === undefined) return
      prevAddr.current = undefined
      try {
        localStorage.removeItem('orlix_user')
        localStorage.removeItem('orlix_token')
      } catch {}
      window.dispatchEvent(new CustomEvent('orlix:wallet:disconnected'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address, status])

  // ── On mount: if wagmi already has a session, re-auth if token is stale ─────
  useEffect(() => {
    if (status === 'connected' && address && prevAddr.current === undefined) {
      prevAddr.current = address
      const existingToken = localStorage.getItem('orlix_token') || ''
      if (!existingToken || existingToken.startsWith('wallet:')) {
        // No real Privy token yet — authenticate now
        authenticate(address).then(userData => {
          window.dispatchEvent(
            new CustomEvent('orlix:wallet:connected', {
              detail: { address, display: userData.display },
            })
          )
        })
      } else {
        // Already have a Privy token — just fire the connected event
        const display = `${address.slice(0, 6)}…${address.slice(-4)}`
        window.dispatchEvent(
          new CustomEvent('orlix:wallet:connected', { detail: { address, display } })
        )
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { signing }
}
