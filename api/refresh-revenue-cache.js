import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_ORG_KEY || process.env.STRIPE_SECRET_KEY);

const ACCOUNTS = [
  { id: 'acct_1SxS6yRfMsviJLHg', name: 'claw_mart', marketplace: true },
  { id: 'acct_1SwiqtDtmukBWxkL', name: 'felix_craft', marketplace: false },
  { id: 'acct_1SwUyqDAsOYrsvx8', name: 'polylogue', marketplace: false },
];

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ltkehrsehoebzajkqrcp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FELIX_CREATOR_ID = '060f72a9-ecf3-4132-9fd7-a460036bca5a';
const CRON_SECRET = process.env.CRON_SECRET;

function toCentralDate(unixTs) {
  return new Date(unixTs * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

async function fetchChargesSince(acctId, since) {
  const charges = [];
  let hasMore = true;
  let startingAfter;
  while (hasMore) {
    const params = { limit: 100 };
    if (since) params.created = { gte: since };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe.charges.list(params, { stripeAccount: acctId });
    charges.push(...page.data);
    hasMore = page.has_more;
    if (page.data.length) startingAfter = page.data[page.data.length - 1].id;
  }
  return charges;
}

async function fetchTransfersSince(acctId, since) {
  const transfers = [];
  let hasMore = true;
  let startingAfter;
  while (hasMore) {
    const params = { limit: 100 };
    if (since) params.created = { gte: since };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe.transfers.list(params, { stripeAccount: acctId });
    transfers.push(...page.data);
    hasMore = page.has_more;
    if (page.data.length) startingAfter = page.data[page.data.length - 1].id;
  }
  return transfers;
}

async function upsertCache(accountKey, data) {
  const body = {
    account_key: accountKey,
    net_cents: data.net,
    gross_cents: data.gross,
    transfers_cents: data.transfers,
    products_sold: data.sold,
    d7_cents: data.d7,
    d30_cents: data.d30,
    d30_sold: data.d30Sold,
    daily_json: JSON.stringify(data.daily),
    cached_through: data.cachedThrough,
    updated_at: new Date().toISOString(),
  };

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/revenue_cache?on_conflict=account_key`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed for ${accountKey}: ${text}`);
  }
}

async function readExistingCache() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/revenue_cache?select=*`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  const map = {};
  if (Array.isArray(rows)) {
    for (const row of rows) map[row.account_key] = row;
  }
  return map;
}

/**
 * Incremental refresh for a Stripe account.
 *
 * 1. Read existing cache row (has all-time totals + cached_through timestamp)
 * 2. Fetch only NEW charges/transfers since cached_through
 * 3. Add new amounts to stored all-time totals
 * 4. Recompute 7d/30d/daily from the last 31 days of charges (always fresh)
 *
 * If no cache exists yet (first run), fetches everything.
 */
async function refreshAccount(acct, existingCache, now) {
  const prev = existingCache[acct.name];
  const thirtyOneDaysAgo = now - 31 * 86400;
  const thirtyDaysAgo = now - 30 * 86400;
  const sevenDaysAgo = now - 7 * 86400;

  // Determine how far back to fetch for incremental all-time update
  // Use the earlier of cached_through or 31 days ago so we always
  // have full 30d data for the chart
  const cachedThrough = prev?.cached_through || 0;
  const incrementalSince = Math.min(cachedThrough, thirtyOneDaysAgo);

  const [charges, transfers] = await Promise.all([
    fetchChargesSince(acct.id, incrementalSince),
    acct.marketplace ? fetchTransfersSince(acct.id, incrementalSince) : Promise.resolve([]),
  ]);

  const succeeded = charges.filter(c => c.status === 'succeeded');

  // ── Compute 7d / 30d / daily chart (from fetched window) ──
  const dailyMap = {};
  let d30Gross = 0, d7Gross = 0, d30Sold = 0;

  for (const c of succeeded) {
    const net = c.amount - (c.amount_refunded || 0);
    const date = toCentralDate(c.created);
    dailyMap[date] = (dailyMap[date] || 0) + net;
    if (c.created >= thirtyDaysAgo) { d30Gross += net; d30Sold++; }
    if (c.created >= sevenDaysAgo) d7Gross += net;
  }

  let d30Transfers = 0, d7Transfers = 0;
  for (const t of transfers) {
    const date = toCentralDate(t.created);
    dailyMap[date] = (dailyMap[date] || 0) - t.amount;
    if (t.created >= thirtyDaysAgo) d30Transfers += t.amount;
    if (t.created >= sevenDaysAgo) d7Transfers += t.amount;
  }

  const daily = Object.entries(dailyMap)
    .filter(([date]) => date >= toCentralDate(thirtyDaysAgo))
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // ── Compute all-time totals (incremental) ──
  // New charges since cached_through contribute to all-time totals
  const newCharges = succeeded.filter(c => c.created > cachedThrough);
  const newTransfers = transfers.filter(t => t.created > cachedThrough);

  const newGross = newCharges.reduce((s, c) => s + c.amount - (c.amount_refunded || 0), 0);
  const newTransferAmt = newTransfers.reduce((s, t) => s + t.amount, 0);
  const newSold = newCharges.length;

  const allTimeNet = (prev?.net_cents || 0) + newGross - newTransferAmt;
  const allTimeGross = (prev?.gross_cents || 0) + newGross;
  const allTimeTransfers = (prev?.transfers_cents || 0) + newTransferAmt;
  const allTimeSold = (prev?.products_sold || 0) + newSold;

  return {
    net: allTimeNet,
    gross: allTimeGross,
    transfers: allTimeTransfers,
    sold: allTimeSold,
    d7: d7Gross - d7Transfers,
    d30: d30Gross - d30Transfers,
    d30Sold,
    daily,
    cachedThrough: now,
  };
}

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  if (!isVercelCron && CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = Math.floor(Date.now() / 1000);
  const results = {};

  // Read existing cache for incremental updates
  const existingCache = await readExistingCache();

  // Process all Stripe accounts in parallel
  const accountResults = await Promise.allSettled(
    ACCOUNTS.map(acct => refreshAccount(acct, existingCache, now))
  );

  for (let i = 0; i < ACCOUNTS.length; i++) {
    const acct = ACCOUNTS[i];
    const result = accountResults[i];
    if (result.status === 'rejected') {
      console.error(`Error processing ${acct.name}:`, result.reason?.message);
      results[acct.name] = { error: result.reason?.message };
      continue;
    }
    try {
      const metrics = result.value;
      await upsertCache(acct.name, metrics);
      results[acct.name] = { net: metrics.net, d30: metrics.d30, d7: metrics.d7, sold: metrics.sold };
    } catch (e) {
      console.error(`Error upserting ${acct.name}:`, e.message);
      results[acct.name] = { error: e.message };
    }
  }

  // Felix CM from Supabase purchases
  // Two lightweight queries instead of fetching all rows:
  // 1. Aggregate totals (all-time net + sold) via RPC or count
  // 2. Only fetch last 31 days of purchases for daily chart
  try {
    const supaHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
    const pRes = await fetch(
      `${SUPABASE_URL}/rest/v1/personas?select=id&creator_id=eq.${FELIX_CREATOR_ID}`,
      { headers: supaHeaders }
    );
    const personas = await pRes.json();
    if (Array.isArray(personas) && personas.length) {
      const ids = personas.map(p => p.id).join(',');
      const thirtyOneDaysAgo = new Date((now - 31 * 86400) * 1000).toISOString();
      const thirtyDaysAgo = now - 30 * 86400;
      const sevenDaysAgo = now - 7 * 86400;

      // Query 1: All-time totals (just count + sum, no row transfer)
      const allTimeRes = await fetch(
        `${SUPABASE_URL}/rest/v1/purchases?select=amount_cents,platform_fee_cents&persona_id=in.(${ids})&refunded_at=is.null`,
        { headers: { ...supaHeaders, Prefer: 'count=exact', Range: '0-0' } }
      );
      const contentRange = allTimeRes.headers.get('content-range');
      const allTimeSold = contentRange ? parseInt(contentRange.split('/')[1]) || 0 : 0;
      // We need the sum — use the existing cache for all-time net and just add new purchases
      const prevCm = existingCache['felix_cm'];

      // Query 2: Only last 31 days of purchases for daily/d7/d30 (small result set)
      const recentRes = await fetch(
        `${SUPABASE_URL}/rest/v1/purchases?select=amount_cents,platform_fee_cents,created_at&persona_id=in.(${ids})&refunded_at=is.null&created_at=gte.${thirtyOneDaysAgo}&order=created_at.asc&limit=5000`,
        { headers: supaHeaders }
      );
      const recentPurchases = await recentRes.json();

      if (Array.isArray(recentPurchases)) {
        let d30 = 0, d7 = 0, d30Sold = 0, recentNet = 0;
        const dailyMap = {};

        for (const p of recentPurchases) {
          const earning = (p.amount_cents || 0) - (p.platform_fee_cents || 0);
          const ts = new Date(p.created_at).getTime() / 1000;
          const date = toCentralDate(ts);
          recentNet += earning;
          if (ts >= thirtyDaysAgo) {
            dailyMap[date] = (dailyMap[date] || 0) + earning;
            d30 += earning;
            d30Sold++;
          }
          if (ts >= sevenDaysAgo) d7 += earning;
        }

        // All-time net: use cached value if available, otherwise use recent as minimum
        const allTimeNet = prevCm ? Math.max(prevCm.net_cents || 0, recentNet) : recentNet;

        const daily = Object.entries(dailyMap)
          .map(([date, amount]) => ({ date, amount }))
          .sort((a, b) => a.date.localeCompare(b.date));

        const data = { net: allTimeNet, gross: allTimeNet, transfers: 0, sold: allTimeSold, d7, d30, d30Sold, daily, cachedThrough: now };
        await upsertCache('felix_cm', data);
        results.felix_cm = { net: allTimeNet, d30, d7, sold: allTimeSold };
      }
    }
  } catch (e) {
    console.error('Error processing felix_cm:', e.message);
    results.felix_cm = { error: e.message };
  }

  res.status(200).json({ ok: true, results, updatedAt: new Date().toISOString() });
}

export const config = {
  api: { bodyParser: false },
  maxDuration: 120,
};
