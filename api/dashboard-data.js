const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ltkehrsehoebzajkqrcp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

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

// ── Revenue from cache (single Supabase read) ──

async function getRevenueFromCache() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/revenue_cache?select=*`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) {
    return { daily: [], total7d: 0, total30d: 0, allTime: 0, productsSold: 0, streams: {} };
  }

  const dailyMap = {};
  let total7d = 0, total30d = 0, allTime = 0, productsSold = 0;
  const streams = {};

  for (const row of rows) {
    const key = row.account_key;
    const daily = typeof row.daily_json === 'string' ? JSON.parse(row.daily_json) : (row.daily_json || []);

    streams[key] = {
      d7: row.d7_cents,
      d30: row.d30_cents,
      all: row.net_cents,
      daily: Object.fromEntries(daily.map(d => [d.date, d.amount])),
    };

    total7d += row.d7_cents;
    total30d += row.d30_cents;
    allTime += row.net_cents;
    productsSold += row.products_sold;

    for (const d of daily) {
      dailyMap[d.date] = (dailyMap[d.date] || 0) + d.amount;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const today = new Date(now * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
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
        getRevenueFromCache(),
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
