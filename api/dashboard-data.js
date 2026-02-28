import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_ORG_KEY || process.env.STRIPE_SECRET_KEY);

// Masinov Stripe accounts
const ACCOUNTS = [
  { id: 'acct_1SxS6yRfMsviJLHg', name: 'claw_mart', marketplace: true },
  { id: 'acct_1SwiqtDtmukBWxkL', name: 'felix_craft', marketplace: false },
  { id: 'acct_1SwUyqDAsOYrsvx8', name: 'polylogue', marketplace: false },
];

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ltkehrsehoebzajkqrcp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FELIX_CREATOR_ID = '060f72a9-ecf3-4132-9fd7-a460036bca5a';

// Base chain constants
const BASE_RPCS = [
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://mainnet.base.org',
];
const TREASURY = '0x778902475c0B5Cf97BB91515a007d983Ad6E70A6';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FELIX_TOKEN = '0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07';
const WETH = '0x4200000000000000000000000000000000000006';
const BALANCE_OF = '0x70a08231000000000000000000000000';

// ── Base chain helpers ──

async function rpcCall(method, params) {
  for (const rpc of BASE_RPCS) {
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(5000),
      });
      const json = await res.json();
      if (json.result) return json.result;
    } catch {}
  }
  return null;
}

async function getEthBalance(addr) {
  const hex = await rpcCall('eth_getBalance', [addr, 'latest']);
  if (!hex) return null;
  return Number(BigInt(hex)) / 1e18;
}

async function getErc20Balance(token, addr, decimals) {
  const paddedAddr = addr.toLowerCase().replace('0x', '');
  const data = BALANCE_OF + paddedAddr;
  const hex = await rpcCall('eth_call', [{ to: token, data }, 'latest']);
  if (!hex) return null;
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
    const pairs = (json.pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return pairs.length ? parseFloat(pairs[0].priceUsd) : 0;
  } catch {
    return 0;
  }
}

// ── Stripe helpers (30d only for chart data) ──

async function fetchCharges(acctId, createdGte) {
  const charges = [];
  let hasMore = true;
  let startingAfter;
  while (hasMore) {
    const params = { limit: 100, created: { gte: createdGte } };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe.charges.list(params, { stripeAccount: acctId });
    charges.push(...page.data);
    hasMore = page.has_more;
    if (page.data.length) startingAfter = page.data[page.data.length - 1].id;
  }
  return charges;
}

async function fetchTransfers(acctId, createdGte) {
  const transfers = [];
  let hasMore = true;
  let startingAfter;
  while (hasMore) {
    const params = { limit: 100, created: { gte: createdGte } };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe.transfers.list(params, { stripeAccount: acctId });
    transfers.push(...page.data);
    hasMore = page.has_more;
    if (page.data.length) startingAfter = page.data[page.data.length - 1].id;
  }
  return transfers;
}

// ── Cached all-time totals from Supabase ──

async function getCachedTotals() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/revenue_cache?select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    if (!Array.isArray(rows)) return {};
    const map = {};
    for (const row of rows) {
      map[row.account_key] = {
        net: row.net_cents,
        sold: row.products_sold,
        cachedThrough: row.cached_through,
      };
    }
    return map;
  } catch (e) {
    console.error('Failed to read revenue cache:', e.message);
    return {};
  }
}

// ── Felix CM earnings (30d only) ──

async function fetchFelixCMRecent(sinceTs) {
  const pRes = await fetch(
    `${SUPABASE_URL}/rest/v1/personas?select=id&creator_id=eq.${FELIX_CREATOR_ID}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const personas = await pRes.json();
  if (!Array.isArray(personas) || !personas.length) return [];

  const ids = personas.map(p => p.id).join(',');
  const url = `${SUPABASE_URL}/rest/v1/purchases?select=amount_cents,platform_fee_cents,created_at&persona_id=in.(${ids})&refunded_at=is.null&created_at=gte.${new Date(sinceTs * 1000).toISOString()}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const purchases = await res.json();
  return Array.isArray(purchases) ? purchases : [];
}

// ── Main revenue calculation ──

function toCentralDate(unixTs) {
  return new Date(unixTs * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

async function getRevenue() {
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 86400;
  const sevenDaysAgo = now - 7 * 86400;

  // Read cached all-time totals (instant, no pagination)
  const cache = await getCachedTotals();

  const dailyMap = {};
  let total30d = 0;
  let total7d = 0;
  let allTime = 0;
  let productsSold = 0;

  // Fetch only 30d charges per Stripe account (fast, bounded)
  const acctPromises = ACCOUNTS.map(async (acct) => {
    try {
      const [charges, transfers] = await Promise.all([
        fetchCharges(acct.id, thirtyDaysAgo),
        acct.marketplace ? fetchTransfers(acct.id, thirtyDaysAgo) : Promise.resolve([]),
      ]);

      const succeeded = charges.filter(c => c.status === 'succeeded');
      const transfersByDay = {};
      let totalTransfers30d = 0;

      if (acct.marketplace) {
        for (const t of transfers) {
          const date = toCentralDate(t.created);
          transfersByDay[date] = (transfersByDay[date] || 0) + t.amount;
          totalTransfers30d += t.amount;
        }
      }

      let acct30d = 0;
      let acct7d = 0;
      let acctSold = 0;
      const acctDaily = {};

      for (const c of succeeded) {
        const net = c.amount - (c.amount_refunded || 0);
        const date = toCentralDate(c.created);
        acctDaily[date] = (acctDaily[date] || 0) + net;
        acct30d += net;
        if (c.created >= sevenDaysAgo) acct7d += net;
        acctSold++;
      }

      if (acct.marketplace) {
        acct30d -= totalTransfers30d;
        for (const [date, amount] of Object.entries(transfersByDay)) {
          acctDaily[date] = (acctDaily[date] || 0) - amount;
          const dateTs = new Date(date + 'T06:00:00Z').getTime() / 1000;
          if (dateTs >= sevenDaysAgo) acct7d -= amount;
        }
      }

      // All-time = cached total (if available), otherwise fall back to 30d
      const cached = cache[acct.name];
      const acctAllTime = cached ? cached.net : acct30d;
      const acctAllSold = cached ? cached.sold : acctSold;

      return { daily: acctDaily, d30: acct30d, d7: acct7d, all: acctAllTime, sold: acctSold, allSold: acctAllSold };
    } catch (e) {
      console.error(`Stripe error for ${acct.name}:`, e.message);
      return { daily: {}, d30: 0, d7: 0, all: 0, sold: 0, allSold: 0 };
    }
  });

  // Felix CM 30d
  const felixCMPromise = (async () => {
    try {
      const purchases = await fetchFelixCMRecent(thirtyDaysAgo);
      let d30 = 0, d7 = 0, sold = 0;
      const daily = {};
      for (const p of purchases) {
        const earning = (p.amount_cents || 0) - (p.platform_fee_cents || 0);
        const ts = new Date(p.created_at).getTime() / 1000;
        const date = toCentralDate(ts);
        daily[date] = (daily[date] || 0) + earning;
        d30 += earning;
        if (ts >= sevenDaysAgo) d7 += earning;
        sold++;
      }
      const cached = cache.felix_cm;
      return { daily, d30, d7, all: cached ? cached.net : d30, sold, allSold: cached ? cached.sold : sold };
    } catch (e) {
      console.error('Felix CM error:', e.message);
      return { daily: {}, d30: 0, d7: 0, all: 0, sold: 0, allSold: 0 };
    }
  })();

  const results = await Promise.all([...acctPromises, felixCMPromise]);
  const streamNames = [...ACCOUNTS.map(a => a.name), 'felix_cm'];
  const streams = {};

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const name = streamNames[i];
    total30d += r.d30;
    total7d += r.d7;
    allTime += r.all;
    productsSold += r.allSold;
    for (const [date, amount] of Object.entries(r.daily)) {
      dailyMap[date] = (dailyMap[date] || 0) + amount;
    }
    streams[name] = { d7: r.d7, d30: r.d30, all: r.all, daily: r.daily };
  }

  const today = toCentralDate(now);
  const daily = Object.entries(dailyMap)
    .filter(([date]) => date <= today)
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { daily, total7d, total30d, allTime, productsSold, streams };
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
        getRevenue(),
        getEthPrice(),
        getFelixPrice(),
        getEthBalance(TREASURY),
        getErc20Balance(WETH, TREASURY, 18),
        getErc20Balance(USDC, TREASURY, 6),
        getErc20Balance(FELIX_TOKEN, TREASURY, 18),
        getErc20Balance(FELIX_TOKEN, DEAD, 18),
      ]);

    const totalEth = (treasuryEth ?? 0) + (treasuryWeth ?? 0);
    const rpcOk = treasuryEth !== null && treasuryWeth !== null && treasuryUsdc !== null && treasuryFelix !== null && burnedFelix !== null;

    res.status(200).json({
      revenue: {
        daily: revenue.daily,
        total7d: revenue.total7d,
        total30d: revenue.total30d,
        allTime: revenue.allTime,
        streams: revenue.streams,
      },
      treasury: {
        eth: rpcOk ? totalEth.toFixed(6) : null,
        usdc: treasuryUsdc !== null ? treasuryUsdc.toFixed(2) : null,
        felix: treasuryFelix !== null ? Math.floor(treasuryFelix).toLocaleString('en-US') : null,
        felixRaw: treasuryFelix !== null ? Math.floor(treasuryFelix) : null,
        ethUsd: ethPrice,
        felixUsd: felixPrice,
      },
      token: {
        burned: burnedFelix !== null ? Math.floor(burnedFelix).toLocaleString('en-US') : null,
        burnedRaw: burnedFelix !== null ? Math.floor(burnedFelix) : null,
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
