// x402 paid endpoint — B20 Token Standard Info
// $0.01 USDC per request (Base network, USDC)
// Builder Code: bc_cxvityc7

const { withX402 } = require('./_x402guard');
const b20Handler = require('./b20');

module.exports = withX402(b20Handler, {
  path:       '/api/x402-b20',
  amountUsdc: 0.01,
  description: 'B20 token standard info on Base — variants, features, live network stats, deployment guide',
});
