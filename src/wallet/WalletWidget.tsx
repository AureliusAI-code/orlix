import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useWalletSession } from './hooks/useWalletSession'

export function WalletWidget() {
  const { signing } = useWalletSession()

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
        if (!mounted) {
          return (
            <div
              aria-hidden
              style={{ opacity: 0, pointerEvents: 'none', height: 0, overflow: 'hidden' }}
            />
          )
        }

        const authing   = authenticationStatus === 'loading'
        const connected =
          !!account &&
          !!chain &&
          (!authenticationStatus || authenticationStatus === 'authenticated')

        // ── Not connected ────────────────────────────────────────────────────
        if (!connected) {
          if (authing || signing) {
            return (
              <button className="ow-btn ow-btn-pending" disabled type="button">
                <div className="ow-dot ow-dot-pending" />
                {signing ? 'Signing…' : 'Connecting…'}
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

        // ── Wrong network ────────────────────────────────────────────────────
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

        // ── Connected (may still be signing) ────────────────────────────────
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
                <img src={chain.iconUrl} alt={chain.name} className="ow-chain-ico" />
              )}
              {chain.name}
            </button>

            {/* Account pill — shows signing indicator while SIWE is in progress */}
            <button
              className={`ow-btn ow-btn-connected${signing ? ' ow-btn-pending' : ''}`}
              onClick={signing ? undefined : openAccountModal}
              disabled={signing}
              type="button"
              aria-label={signing ? 'Signing in…' : 'Open account details'}
            >
              <div className={`ow-dot${signing ? ' ow-dot-pending' : ' ow-dot-connected'}`} />
              {signing ? (
                <span className="ow-addr">Signing…</span>
              ) : (
                <>
                  {account.displayBalance && (
                    <span className="ow-balance">{account.displayBalance} · </span>
                  )}
                  <span className="ow-addr">{account.displayName}</span>
                </>
              )}
            </button>
          </div>
        )
      }}
    </ConnectButton.Custom>
  )
}
