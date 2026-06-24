import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import {
  metaMaskWallet,
  coinbaseWallet,
  walletConnectWallet,
  injectedWallet,
  rainbowWallet,
} from '@rainbow-me/rainbowkit/wallets'
import { base } from 'wagmi/chains'

// ── WalletConnect Project ID ──────────────────────────────────────────────────
// Required for WalletConnect QR / mobile deeplinks.
// 1. Go to https://cloud.walletconnect.com → create a free project
// 2. Add VITE_WALLETCONNECT_PROJECT_ID to Vercel environment variables
// MetaMask and Coinbase Wallet work even without this ID.
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? ''

const wallets = projectId
  ? [
      { groupName: 'Popular', wallets: [metaMaskWallet, coinbaseWallet, walletConnectWallet] },
      { groupName: 'More',    wallets: [rainbowWallet, injectedWallet] },
    ]
  : [
      { groupName: 'Popular', wallets: [metaMaskWallet, coinbaseWallet, injectedWallet] },
      { groupName: 'More',    wallets: [rainbowWallet] },
    ]

export const wagmiConfig = getDefaultConfig({
  appName: 'Orlix AI',
  appDescription: 'AI-powered crypto assistant on Base',
  appUrl: 'https://www.orlixai.xyz',
  appIcon: 'https://www.orlixai.xyz/orlix-logo.jpeg',
  projectId: projectId || 'dummy', // wagmi requires a non-empty string; WalletConnect won't work without a real ID
  chains: [base],
  wallets,
  ssr: false,
})
