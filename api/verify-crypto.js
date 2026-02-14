import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// USDC on Base
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RECEIVING_WALLET = (process.env.CRYPTO_RECEIVING_WALLET || '').toLowerCase();
// $29 in USDC (6 decimals) = 29000000, allow some variance for gas/rounding
const MIN_AMOUNT = 28_000_000; // $28 minimum
const MAX_AMOUNT = 35_000_000; // $35 maximum

const DOWNLOAD_URL = 'https://felixcraft.ai/dl/c5768e3409026bab01bb1649.pdf';
const THANK_YOU_URL = 'https://felixcraft.ai/168a1eb2dd92fd596ac191d4';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://felixcraft.ai');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    // Parse JSON body manually since we might not have bodyParser
    if (typeof req.body === 'string') {
      body = JSON.parse(req.body);
    } else if (req.body) {
      body = req.body;
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { email, txHash } = body;

  if (!email || !txHash) {
    return res.status(400).json({ error: 'Email and transaction hash are required' });
  }

  // Basic validation
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return res.status(400).json({ error: 'Invalid transaction hash format' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  try {
    // Verify the transaction on Base using public RPC
    const txReceipt = await fetchTxReceipt(txHash);

    if (!txReceipt || txReceipt.status !== '0x1') {
      return res.status(400).json({ error: 'Transaction not found or failed. Please check the hash and try again.' });
    }

    // Verify it's a USDC transfer to our wallet
    const transfer = verifyUSDCTransfer(txReceipt);

    if (!transfer.valid) {
      return res.status(400).json({ error: transfer.reason });
    }

    // Transaction verified — send the download email
    try {
      await resend.emails.send({
        from: 'Felix Craft <felix@masinov.co>',
        to: email,
        subject: 'Your "How to Hire an AI" download is ready',
        html: buildEmailHTML(),
      });
      console.log('Crypto purchase verified and email sent:', { email, txHash, amount: transfer.amount });
    } catch (emailErr) {
      // Email failed but tx is valid — still return the download link
      console.error('Email send failed (returning link anyway):', emailErr);
    }

    // Return success with download URL regardless of email success
    return res.status(200).json({
      success: true,
      downloadUrl: DOWNLOAD_URL,
      thankYouUrl: THANK_YOU_URL,
      message: 'Payment verified! Your download is ready.',
    });

  } catch (err) {
    console.error('Verification error:', err);
    return res.status(500).json({ error: 'Verification failed. Please email felix@masinov.co with your transaction hash.' });
  }
}

async function fetchTxReceipt(txHash) {
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    }),
  });

  const data = await response.json();
  return data.result;
}

function verifyUSDCTransfer(receipt) {
  // Look for ERC-20 Transfer event in logs
  // Transfer(address from, address to, uint256 value)
  // Topic[0] = keccak256("Transfer(address,address,uint256)")
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

  for (const log of receipt.logs || []) {
    // Check it's from the USDC contract
    if (log.address.toLowerCase() !== USDC_CONTRACT.toLowerCase()) continue;

    // Check it's a Transfer event
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC) continue;

    // Topic[2] is the 'to' address (padded to 32 bytes)
    const toAddress = '0x' + log.topics[2].slice(26).toLowerCase();

    // Check the receiving wallet if configured
    if (RECEIVING_WALLET && toAddress !== RECEIVING_WALLET) continue;

    // Data contains the amount (uint256)
    const amount = parseInt(log.data, 16);

    if (amount >= MIN_AMOUNT && amount <= MAX_AMOUNT) {
      return { valid: true, amount: amount / 1_000_000 };
    } else if (amount < MIN_AMOUNT) {
      return { valid: false, reason: `Payment amount ($${(amount / 1_000_000).toFixed(2)}) is below the required amount.` };
    }
  }

  return { valid: false, reason: 'No valid USDC transfer found in this transaction. Please check the transaction hash.' };
}

function buildEmailHTML() {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { text-align: center; margin-bottom: 30px; }
        .header h1 { font-size: 24px; color: #c4a35a; margin: 0; }
        .content { background: #f9f9f9; border-radius: 8px; padding: 30px; margin-bottom: 20px; }
        .download-btn { display: inline-block; background: #c4a35a; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; }
        .footer { text-align: center; font-size: 14px; color: #666; }
        .footer a { color: #c4a35a; text-decoration: none; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>You're in</h1>
      </div>
      <div class="content">
        <p>Thanks for grabbing <strong>How to Hire an AI</strong>.</p>
        <p>Click below to download your copy:</p>
        <p style="text-align: center;">
          <a href="${DOWNLOAD_URL}" class="download-btn">Download PDF</a>
        </p>
        <p>You can also access your thank-you page anytime at:<br>
        <a href="${THANK_YOU_URL}">${THANK_YOU_URL}</a></p>
      </div>
      <div class="footer">
        <p>Questions? <a href="https://x.com/FelixCraftAI">@FelixCraftAI</a> · <a href="mailto:felix@masinov.co">felix@masinov.co</a></p>
      </div>
    </body>
    </html>
  `;
}
