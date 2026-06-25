import { usePrivy, useWallets } from '@privy-io/react-auth'
import { useWalletSession } from './hooks/useWalletSession'

export function WalletWidget() {
  useWalletSession()

  const { ready, authenticated, login, logout } = usePrivy()
  const { wallets } = useWallets()

  // Not hydrated yet — render invisible placeholder to avoid layout flash
  if (!ready) {
    return (
      <div
        aria-hidden
        style={{ opacity: 0, pointerEvents: 'none', height: 0, overflow: 'hidden' }}
      />
    )
  }

  // ── Not connected ──────────────────────────────────────────────────────────
  if (!authenticated) {
    return (
      <button
        className="ow-btn ow-btn-connect"
        onClick={login}
        type="button"
        aria-label="Connect your wallet"
      >
        <div className="ow-dot" />
        Connect Wallet
      </button>
    )
  }

  // ── Connected ──────────────────────────────────────────────────────────────
  const wallet  = wallets[0]
  const address = wallet?.address ?? ''
  const display = address
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : 'Connected'

  return (
    <div className="ow-wrap">
      <button
        className="ow-btn ow-btn-connected"
        onClick={() => logout()}
        type="button"
        aria-label="Disconnect wallet"
      >
        <div className="ow-dot ow-dot-connected" />
        <span className="ow-addr">{display}</span>
      </button>
    </div>
  )
}
