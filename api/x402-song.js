// x402 paid endpoint — Crypto Song Lyrics
// $0.05 USDC per song (Base network, USDC)
// Builder Code: bc_cxvityc7

const { withX402 } = require('./_x402guard');
const songHandler = require('./song');

module.exports = withX402(songHandler, {
  path:       '/api/x402-song',
  amountUsdc: 0.05,
  description: 'Orlix AI crypto song lyrics — trap, phonk, pop, drill, hype, ballad',
});
