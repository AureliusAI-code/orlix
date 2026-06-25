// x402 paid endpoint — Token Security Analysis
// $0.05 USDC per request (Base network, USDC)
// Builder Code: bc_cxvityc7

const { withX402 } = require('./_x402guard');
const analyzeHandler = require('./analyze');

module.exports = withX402(analyzeHandler, {
  path:       '/api/x402-analyze',
  amountUsdc: 0.05,
  description: 'Orlix AI token security analysis — red flags, green flags, AI verdict',
});
