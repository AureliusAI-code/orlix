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
// 1. Go to https://cloud.walletconnect.com and create a free project
// 2. Add VITE_WALLETCONNECT_PROJECT_ID to your Vercel environment variables
// MetaMask and Coinbase Wallet work even without this ID.
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? ''

if (!projectId && import.meta.env.DEV) {
  console.warn(
    '[OrlixWallet] VITE_WALLETCONNECT_PROJECT_ID is not set.\n' +
    'WalletConnect QR / mobile links will not work.\n' +
    'Get a free ID at https://cloud.walletconnect.com'
  )
}

export const wagmiConfig = getDefaultConfig({
  appName: 'Orlix AI',
  appDescription: 'AI-powered crypto assistant on Base',
  appUrl: 'https://orlix.ai',
  appIcon: 'https://orlix.ai/orlix-logo.jpeg',
  projectId,
  chains: [base],
  wallets: [
    {
      groupName: 'Popular',
      wallets: [metaMaskWallet, coinbaseWallet, walletConnectWallet],
    },
    {
      groupName: 'More',
      wallets: [rainbowWallet, injectedWallet],
    },
  ],
  ssr: false,
})
