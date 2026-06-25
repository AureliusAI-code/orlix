// x402 payment guard for Vercel serverless
// Seller-side: returns 402 with payment requirements, verifies payment, then delegates to handler
// Builder Code: bc_cxvityc7 (Orlix AI)

const FACILITATOR_VERIFY = 'https://x402.org/v1/verify';
const FACILITATOR_SETTLE = 'https://x402.org/v1/settle';
const USDC_BASE  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BUILDER_CODE = 'bc_cxvityc7';
const X402_VERSION = 1;
const BASE_URL = 'https://orlixai.xyz';

function buildRequirements(path, amountUsdc, description) {
  const payTo = process.env.PAYTO_ADDRESS || '';
  return [{
    scheme:             'exact',
    network:            'base',
    maxAmountRequired:  String(Math.round(amountUsdc * 1_000_000)), // USDC 6 decimals
    resource:           `${BASE_URL}${path}`,
    description,
    mimeType:           'application/json',
    payTo,
    maxTimeoutSeconds:  300,
    asset:              USDC_BASE,
    extra: {
      name:        'Orlix AI',
      builderCode: BUILDER_CODE,
    },
  }];
}

async function callFacilitator(endpoint, payment, requirements) {
  const r = await fetch(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ payment, paymentRequirements: requirements }),
    signal:  AbortSignal.timeout(12_000),
  });
  if (!r.ok) throw new Error(`x402 facilitator error: ${r.status}`);
  return r.json();
}

// Wraps any Vercel handler with x402 payment gate.
// opts: { amountUsdc: number, description: string, path: string }
function withX402(handler, opts) {
  return async function x402Handler(req, res) {
    const payment  = req.headers['x-payment'];
    const path     = opts.path || req.url.split('?')[0];
    const reqs     = buildRequirements(path, opts.amountUsdc, opts.description);
    const acceptsB64 = Buffer.from(JSON.stringify(reqs)).toString('base64');

    if (!payment) {
      res.setHeader('WWW-Authenticate', `X402 version="${X402_VERSION}" accepts="${acceptsB64}"`);
      res.setHeader('X-Payment-Required', '1');
      return res.status(402).json({
        x402Version: X402_VERSION,
        error:       'Payment required',
        accepts:     reqs,
      });
    }

    // Verify payment with Coinbase facilitator
    let verified;
    try {
      verified = await callFacilitator(FACILITATOR_VERIFY, payment, reqs);
    } catch (e) {
      return res.status(503).json({ error: 'Payment verification temporarily unavailable.' });
    }

    if (!verified.isValid) {
      res.setHeader('WWW-Authenticate', `X402 version="${X402_VERSION}" accepts="${acceptsB64}"`);
      return res.status(402).json({
        x402Version: X402_VERSION,
        error:       'Payment invalid',
        reason:      verified.invalidReason || 'Verification failed',
        accepts:     reqs,
      });
    }

    // Settle the payment (records builderCode onchain)
    let settleResult = null;
    try {
      settleResult = await callFacilitator(FACILITATOR_SETTLE, payment, reqs);
    } catch {
      // Settle is best-effort — still serve if it fails
    }

    res.setHeader('X-Builder-Code', BUILDER_CODE);
    if (settleResult?.transaction) {
      res.setHeader('X-Payment-Response', Buffer.from(JSON.stringify(settleResult)).toString('base64'));
    }

    return handler(req, res);
  };
}

module.exports = { withX402, buildRequirements, BUILDER_CODE };
