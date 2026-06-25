// x402 paid endpoint — Multi-Model AI Chat
// $0.002 USDC per message (Base network, USDC)
// Builder Code: bc_cxvityc7

const { withX402 } = require('./_x402guard');
const chatHandler = require('./chat');

module.exports = withX402(chatHandler, {
  path:       '/api/x402-chat',
  amountUsdc: 0.002,
  description: 'Orlix AI chat — 19 frontier models including Claude, GPT-5, Gemini, Grok',
});
