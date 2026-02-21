import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Masinov Stripe accounts
const ACCOUNTS = [
  { id: 'acct_1SxS6yRfMsviJLHg', name: 'Claw Mart' },
  { id: 'acct_1SwiqtDtmukBWxkL', name: 'felixcraft.ai' },
  { id: 'acct_1SwUyqDAsOYrsvx8', name: 'Polylogue' },
  { id: 'acct_1SysljRnJP71h2KV', name: 'Felix CM' },
];

// Base chain constants
const BASE_RPC = 'https://mainnet.base.org';
const TREASURY = '0x114d78163Fa1AB2488A5A2281317953C8679f508';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FELIX_TOKEN = '0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07';
const BALANCE_OF = '0x70a08231000000000000000000000000';

async function rpcCall(method, params) {
  const res = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json.result;
}

async function getEthBalance(addr) {
  const hex = await rpcCall('eth_getBalance', [addr, 'latest']);
  return Number(BigInt(hex)) / 1e18;
}

async function getErc20Balance(token, addr, decimals) {
  const paddedAddr = addr.toLowerCase().replace('0x', '');
  const data = BALANCE_OF + paddedAddr;
  const hex = await rpcCall('eth_call', [{ to: token, data }, 'latest']);
  return Number(BigInt(hex)) / 10 ** decimals;
}

async function getEthPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const json = await res.json();
    return json.ethereum.usd;
  } catch {
    return 0;
  }
}

async function getStripeRevenue() {
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 86400;
  const sevenDaysAgo = now - 7 * 86400;

  // Collect daily revenue across all accounts
  const dailyMap = {};
  let total30d = 0;
  let total7d = 0;
  let allTime = 0;
  let productsSold = 0;

  for (const acct of ACCOUNTS) {
    try {
      // Get balance transactions for last 30 days
      let hasMore = true;
      let startingAfter = undefined;

      while (hasMore) {
        const params = {
          created: { gte: thirtyDaysAgo },
          limit: 100,
          expand: ['data.source'],
        };
        if (startingAfter) params.starting_after = startingAfter;

        const txns = await stripe.balanceTransactions.list(params, {
          stripeAccount: acct.id,
        });

        for (const txn of txns.data) {
          if (txn.type === 'charge' || txn.type === 'payment') {
            const net = txn.net; // in cents, already net of fees
            const date = new Date(txn.created * 1000).toISOString().slice(0, 10);
            dailyMap[date] = (dailyMap[date] || 0) + net;
            total30d += net;
            if (txn.created >= sevenDaysAgo) total7d += net;
            productsSold++;
          }
        }

        hasMore = txns.has_more;
        if (hasMore && txns.data.length > 0) {
          startingAfter = txns.data[txns.data.length - 1].id;
        }
      }

      // Get all-time balance (available + pending)
      const balance = await stripe.balance.retrieve({ stripeAccount: acct.id });
      for (const b of [...balance.available, ...balance.pending]) {
        if (b.currency === 'usd') allTime += b.amount;
      }
    } catch (e) {
      console.error(`Stripe error for ${acct.name}:`, e.message);
    }
  }

  // Build sorted daily array
  const daily = Object.entries(dailyMap)
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { daily, total7d, total30d, allTime, productsSold };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const [revenue, ethPrice, treasuryEth, treasuryUsdc, treasuryFelix, burnedFelix] =
      await Promise.all([
        getStripeRevenue(),
        getEthPrice(),
        getEthBalance(TREASURY),
        getErc20Balance(USDC, TREASURY, 6),
        getErc20Balance(FELIX_TOKEN, TREASURY, 18),
        getErc20Balance(FELIX_TOKEN, DEAD, 18),
      ]);

    res.status(200).json({
      revenue: {
        daily: revenue.daily,
        total7d: revenue.total7d,
        total30d: revenue.total30d,
        allTime: revenue.allTime,
      },
      treasury: {
        eth: treasuryEth.toFixed(6),
        usdc: treasuryUsdc.toFixed(2),
        felix: Math.floor(treasuryFelix).toLocaleString('en-US'),
        felixRaw: Math.floor(treasuryFelix),
        ethUsd: ethPrice,
      },
      token: {
        burned: Math.floor(burnedFelix).toLocaleString('en-US'),
        burnedRaw: Math.floor(burnedFelix),
        sold: '0',
      },
      stats: {
        productsSold: revenue.productsSold,
        clawmartCreators: 8,
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Dashboard data error:', e);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
}

export const config = {
  api: { bodyParser: false },
};
