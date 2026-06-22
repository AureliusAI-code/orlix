import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useWalletSession } from './hooks/useWalletSession'

// WalletWidget renders into any #orlix-wallet div on the page.
// Uses RainbowKit's ConnectButton.Custom so we control the styling
// while RainbowKit handles wallet detection, modals, and chain switching.
export function WalletWidget() {
  // Sync wagmi state → localStorage + dispatch DOM events
  useWalletSession()

  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openAccountModal,
        openChainModal,
        openConnectModal,
        authenticationStatus,
        mounted,
      }) => {
        // Render nothing until hydrated to avoid layout flash
        if (!mounted) {
          return (
            <div
              aria-hidden
              style={{ opacity: 0, pointerEvents: 'none', height: 0, overflow: 'hidden' }}
            />
          )
        }

        const authing = authenticationStatus === 'loading'
        const connected =
          !!account &&
          !!chain &&
          (!authenticationStatus || authenticationStatus === 'authenticated')

        // ── Not connected ─────────────────────────────────────────────────────
        if (!connected) {
          if (authing) {
            return (
              <button className="ow-btn ow-btn-pending" disabled type="button">
                <div className="ow-dot ow-dot-pending" />
                Connecting…
              </button>
            )
          }

          return (
            <button
              className="ow-btn ow-btn-connect"
              onClick={openConnectModal}
              type="button"
              aria-label="Connect your wallet"
            >
              <div className="ow-dot" />
              Connect Wallet
            </button>
          )
        }

        // ── Wrong network ──────────────────────────────────────────────────────
        if (chain.unsupported) {
          return (
            <button
              className="ow-btn ow-btn-wrong"
              onClick={openChainModal}
              type="button"
              aria-label="Wrong network — click to switch to Base"
            >
              ⚠&nbsp;Wrong Network
            </button>
          )
        }

        // ── Connected ──────────────────────────────────────────────────────────
        return (
          <div className="ow-wrap">
            {/* Chain pill */}
            <button
              className="ow-btn ow-btn-chain"
              onClick={openChainModal}
              type="button"
              aria-label={`Switch network (currently ${chain.name})`}
            >
              {chain.hasIcon && chain.iconUrl && (
                <img
                  src={chain.iconUrl}
                  alt={chain.name}
                  className="ow-chain-ico"
                />
              )}
              {chain.name}
            </button>

            {/* Account pill */}
            <button
              className="ow-btn ow-btn-connected"
              onClick={openAccountModal}
              type="button"
              aria-label="Open account details"
            >
              <div className="ow-dot ow-dot-connected" />
              {account.displayBalance && (
                <span className="ow-balance">{account.displayBalance} · </span>
              )}
              <span className="ow-addr">{account.displayName}</span>
            </button>
          </div>
        )
      }}
    </ConnectButton.Custom>
  )
}
