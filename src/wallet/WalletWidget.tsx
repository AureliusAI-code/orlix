import { useState, useEffect, useRef } from 'react'
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
  const [open, setOpen] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)

  const wallet  = wallets[0]
  const address = wallet?.address ?? ''

  useEffect(() => {
    if (!address) { setBalance(null); return }
    publicClient
      .getBalance({ address: address as `0x${string}` })
      .then(bal => setBalance(parseFloat(formatEther(bal)).toFixed(4)))
      .catch(() => setBalance(null))
  }, [address])

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

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
    <div className="ow-wrap" ref={dropRef} style={{ position: 'relative' }}>
      <div className="ow-network-pill">
        <span className="ow-net-dot" />
        Base
      </div>
      {balance !== null && (
        <span className="ow-balance">{balance} ETH</span>
      )}
      <button
        className="ow-btn ow-btn-connected"
        onClick={() => setOpen(o => !o)}
        type="button"
        aria-label="Wallet options"
      >
        <div className="ow-dot ow-dot-connected" />
        <span className="ow-addr">{display}</span>
        <svg width="8" height="5" viewBox="0 0 8 5" fill="none" style={{ marginLeft: 2, opacity: 0.5 }}>
          <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="ow-dropdown">
          <button
            className="ow-drop-item"
            onClick={() => { navigator.clipboard?.writeText(address); setOpen(false) }}
          >
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="7" y="7" width="10" height="12" rx="1.5"/>
              <path d="M4 13H3a1.5 1.5 0 01-1.5-1.5V3A1.5 1.5 0 013 1.5h9A1.5 1.5 0 0113.5 3v1"/>
            </svg>
            Copy address
          </button>
          <a
            className="ow-drop-item"
            href={`https://basescan.org/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
          >
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 3h6v6"/><path d="M17 3l-8 8"/><path d="M9 5H4a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1v-5"/>
            </svg>
            View on BaseScan
          </a>
          <div className="ow-drop-sep" />
          <button
            className="ow-drop-item ow-drop-danger"
            onClick={() => { logout(); setOpen(false) }}
          >
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 3h4a1 1 0 011 1v12a1 1 0 01-1 1h-4"/><path d="M8 14l-4-4 4-4"/><path d="M4 10h10"/>
            </svg>
            Disconnect
          </button>
        </div>
      )}
    </div>
  )
}
