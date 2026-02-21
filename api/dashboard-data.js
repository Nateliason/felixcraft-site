import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_ORG_KEY || process.env.STRIPE_SECRET_KEY);

// Masinov Stripe accounts (excluding Felix CM — that comes from Supabase)
const ACCOUNTS = [
  { id: 'acct_1SxS6yRfMsviJLHg', name: 'claw_mart', marketplace: true },
  { id: 'acct_1SwiqtDtmukBWxkL', name: 'felix_craft', marketplace: false },
  { id: 'acct_1SwUyqDAsOYrsvx8', name: 'polylogue', marketplace: false },
];

// Felix CM earnings from Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ltkehrsehoebzajkqrcp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FELIX_CREATOR_ID = '060f72a9-ecf3-4132-9fd7-a460036bca5a';

// Base chain constants
const BASE_RPC = 'https://mainnet.base.org';
const TREASURY = '0x778902475c0B5Cf97BB91515a007d983Ad6E70A6';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FELIX_TOKEN = '0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07';
const WETH = '0x4200000000000000000000000000000000000006';
const BALANCE_OF = '0x70a08231000000000000000000000000';

// ── Base chain helpers ──

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

async function getFelixPrice() {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07');
    const json = await res.json();
    // Use the most liquid pair
    const pairs = (json.pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return pairs.length ? parseFloat(pairs[0].priceUsd) : 0;
  } catch {
    return 0;
  }
}

// ── Stripe helpers ──

async function fetchAllCharges(acctId, createdGte) {
  const charges = [];
  let hasMore = true;
  let startingAfter;

  while (hasMore) {
    const params = { limit: 100 };
    if (createdGte) params.created = { gte: createdGte };
    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripe.charges.list(params, { stripeAccount: acctId });
    charges.push(...page.data);
    hasMore = page.has_more;
    if (page.data.length) startingAfter = page.data[page.data.length - 1].id;
  }
  return charges;
}

async function fetchAllTransfers(acctId, createdGte) {
  const transfers = [];
  let hasMore = true;
  let startingAfter;

  while (hasMore) {
    const params = { limit: 100 };
    if (createdGte) params.created = { gte: createdGte };
    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripe.transfers.list(params, { stripeAccount: acctId });
    transfers.push(...page.data);
    hasMore = page.has_more;
    if (page.data.length) startingAfter = page.data[page.data.length - 1].id;
  }
  return transfers;
}

// ── Felix CM earnings from Supabase ──

async function fetchFelixCMEarnings(sinceTs) {
  // Get Felix's persona IDs
  const pRes = await fetch(
    `${SUPABASE_URL}/rest/v1/personas?select=id&creator_id=eq.${FELIX_CREATOR_ID}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const personas = await pRes.json();
  if (!Array.isArray(personas) || !personas.length) return [];

  const ids = personas.map(p => p.id).join(',');
  let url = `${SUPABASE_URL}/rest/v1/purchases?select=amount_cents,platform_fee_cents,created_at&persona_id=in.(${ids})&refunded_at=is.null`;
  if (sinceTs) {
    url += `&created_at=gte.${new Date(sinceTs * 1000).toISOString()}`;
  }

  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const purchases = await res.json();
  return Array.isArray(purchases) ? purchases : [];
}

// ── Main revenue calculation ──

async function getStripeRevenue() {
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 86400;
  const sevenDaysAgo = now - 7 * 86400;

  const dailyMap = {};
  let total30d = 0;
  let total7d = 0;
  let allTime = 0;
  let productsSold = 0;

  // Fetch 30d charges and ALL charges in parallel per account
  const acctPromises = ACCOUNTS.map(async (acct) => {
    try {
      const [recentCharges, allCharges] = await Promise.all([
        fetchAllCharges(acct.id, thirtyDaysAgo),
        fetchAllCharges(acct.id, null),
      ]);

      const recentSucceeded = recentCharges.filter(c => c.status === 'succeeded');
      const allSucceeded = allCharges.filter(c => c.status === 'succeeded');

      // Transfers for marketplace
      let recentTransfersByDay = {};
      let totalTransfersAll = 0;
      let totalTransfers30d = 0;
      if (acct.marketplace) {
        const [recentTransfers, allTransfers] = await Promise.all([
          fetchAllTransfers(acct.id, thirtyDaysAgo),
          fetchAllTransfers(acct.id, null),
        ]);
        for (const t of recentTransfers) {
          const date = new Date(t.created * 1000).toISOString().slice(0, 10);
          recentTransfersByDay[date] = (recentTransfersByDay[date] || 0) + t.amount;
          totalTransfers30d += t.amount;
        }
        totalTransfersAll = allTransfers.reduce((s, t) => s + t.amount, 0);
      }

      // All-time net
      const allGrossNet = allSucceeded.reduce((s, c) => s + c.amount - (c.amount_refunded || 0), 0);
      const acctAllTime = allGrossNet - totalTransfersAll;

      // 30d + 7d from recent charges
      let acct30d = 0;
      let acct7d = 0;
      let acctSold = 0;
      const acctDaily = {};

      for (const c of recentSucceeded) {
        const net = c.amount - (c.amount_refunded || 0);
        const date = new Date(c.created * 1000).toISOString().slice(0, 10);
        acctDaily[date] = (acctDaily[date] || 0) + net;
        acct30d += net;
        if (c.created >= sevenDaysAgo) acct7d += net;
        acctSold++;
      }

      // Subtract recent transfers for marketplace
      if (acct.marketplace) {
        acct30d -= totalTransfers30d;
        for (const [date, amount] of Object.entries(recentTransfersByDay)) {
          acctDaily[date] = (acctDaily[date] || 0) - amount;
          const dateTs = new Date(date + 'T00:00:00Z').getTime() / 1000;
          if (dateTs >= sevenDaysAgo) acct7d -= amount;
        }
      }

      return { daily: acctDaily, d30: acct30d, d7: acct7d, all: acctAllTime, sold: acctSold };
    } catch (e) {
      console.error(`Stripe error for ${acct.name}:`, e.message);
      return { daily: {}, d30: 0, d7: 0, all: 0, sold: 0 };
    }
  });

  // Felix CM from Supabase
  const felixCMPromise = (async () => {
    try {
      const purchases = await fetchFelixCMEarnings(null);
      let d30 = 0, d7 = 0, all = 0, sold = 0;
      const daily = {};
      for (const p of purchases) {
        const earning = (p.amount_cents || 0) - (p.platform_fee_cents || 0);
        const date = p.created_at.slice(0, 10);
        const ts = new Date(p.created_at).getTime() / 1000;
        all += earning;
        if (ts >= thirtyDaysAgo) {
          daily[date] = (daily[date] || 0) + earning;
          d30 += earning;
          if (ts >= sevenDaysAgo) d7 += earning;
          sold++;
        }
      }
      return { daily, d30, d7, all, sold };
    } catch (e) {
      console.error('Supabase Felix CM error:', e.message);
      return { daily: {}, d30: 0, d7: 0, all: 0, sold: 0 };
    }
  })();

  const results = await Promise.all([...acctPromises, felixCMPromise]);

  for (const r of results) {
    total30d += r.d30;
    total7d += r.d7;
    allTime += r.all;
    productsSold += r.sold;
    for (const [date, amount] of Object.entries(r.daily)) {
      dailyMap[date] = (dailyMap[date] || 0) + amount;
    }
  }

  const daily = Object.entries(dailyMap)
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { daily, total7d, total30d, allTime, productsSold };
}

// ── Handler ──

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const [revenue, ethPrice, felixPrice, treasuryEth, treasuryWeth, treasuryUsdc, treasuryFelix, burnedFelix] =
      await Promise.all([
        getStripeRevenue(),
        getEthPrice(),
        getFelixPrice(),
        getEthBalance(TREASURY),
        getErc20Balance(WETH, TREASURY, 18),
        getErc20Balance(USDC, TREASURY, 6),
        getErc20Balance(FELIX_TOKEN, TREASURY, 18),
        getErc20Balance(FELIX_TOKEN, DEAD, 18),
      ]);

    const totalEth = treasuryEth + treasuryWeth;

    res.status(200).json({
      revenue: {
        daily: revenue.daily,
        total7d: revenue.total7d,
        total30d: revenue.total30d,
        allTime: revenue.allTime,
      },
      treasury: {
        eth: totalEth.toFixed(6),
        usdc: treasuryUsdc.toFixed(2),
        felix: Math.floor(treasuryFelix).toLocaleString('en-US'),
        felixRaw: Math.floor(treasuryFelix),
        ethUsd: ethPrice,
        felixUsd: felixPrice,
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
