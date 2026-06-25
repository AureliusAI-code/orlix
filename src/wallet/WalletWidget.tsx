import { useState, useEffect } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import { createPublicClient, http, formatEther } from 'viem'
import { base } from 'viem/chains'
import { useWalletSession } from './hooks/useWalletSession'

const publicClient = createPublicClient({ chain: base, transport: http() })

export function WalletWidget() {
  useWalletSession()

  const { ready, authenticated, login, logout } = usePrivy()
  const { wallets } = useWallets()
  const [balance, setBalance] = useState<string | null>(null)

  const wallet  = wallets[0]
  const address = wallet?.address ?? ''

  useEffect(() => {
    if (!address) { setBalance(null); return }
    publicClient
      .getBalance({ address: address as `0x${string}` })
      .then(bal => setBalance(parseFloat(formatEther(bal)).toFixed(4)))
      .catch(() => setBalance(null))
  }, [address])

  if (!ready) {
    return (
      <div
        aria-hidden
        style={{ opacity: 0, pointerEvents: 'none', height: 0, overflow: 'hidden' }}
      />
    )
  }

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

  const display = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Connected'

  return (
    <div className="ow-wrap">
      <div className="ow-network-pill">
        <span className="ow-net-dot" />
        Base
      </div>
      {balance !== null && (
        <span className="ow-balance">{balance} ETH</span>
      )}
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
