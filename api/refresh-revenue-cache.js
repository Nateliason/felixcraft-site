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

function computeMetrics(succeeded, transfers, now) {
  const thirtyDaysAgo = now - 30 * 86400;
  const sevenDaysAgo = now - 7 * 86400;

  const gross = succeeded.reduce((s, c) => s + c.amount - (c.amount_refunded || 0), 0);
  const totalTransfers = transfers.reduce((s, t) => s + t.amount, 0);

  // Build daily map and period totals
  const dailyMap = {};
  let d30Gross = 0, d7Gross = 0, d30Sold = 0;

  for (const c of succeeded) {
    const net = c.amount - (c.amount_refunded || 0);
    const date = toCentralDate(c.created);
    dailyMap[date] = (dailyMap[date] || 0) + net;
    if (c.created >= thirtyDaysAgo) { d30Gross += net; d30Sold++; }
    if (c.created >= sevenDaysAgo) d7Gross += net;
  }

  // Subtract transfers per day
  let d30Transfers = 0, d7Transfers = 0;
  for (const t of transfers) {
    const date = toCentralDate(t.created);
    dailyMap[date] = (dailyMap[date] || 0) - t.amount;
    if (t.created >= thirtyDaysAgo) d30Transfers += t.amount;
    if (t.created >= sevenDaysAgo) d7Transfers += t.amount;
  }

  // Convert daily map to sorted array (last 30d only for chart)
  const daily = Object.entries(dailyMap)
    .filter(([date]) => date >= toCentralDate(thirtyDaysAgo))
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    net: gross - totalTransfers,
    gross,
    transfers: totalTransfers,
    sold: succeeded.length,
    d7: d7Gross - d7Transfers,
    d30: d30Gross - d30Transfers,
    d30Sold,
    daily,
  };
}

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  if (!isVercelCron && CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = Math.floor(Date.now() / 1000);
  const thirtyOneDaysAgo = now - 31 * 86400;
  const results = {};

  // Read existing cache to preserve all-time totals (incremental update)
  let existingCache = {};
  try {
    const cacheRes = await fetch(
      `${SUPABASE_URL}/rest/v1/revenue_cache?select=account_key,net_cents,gross_cents,transfers_cents,products_sold,cached_through`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const cacheRows = await cacheRes.json();
    if (Array.isArray(cacheRows)) {
      for (const row of cacheRows) existingCache[row.account_key] = row;
    }
  } catch (e) {
    console.error('Failed to read existing cache:', e.message);
  }

  // Only fetch last 31 days of charges (enough for 7d/30d/daily chart).
  // All-time totals are preserved from existing cache + new charges.
  // This prevents timeout as charge volume grows.
  const accountResults = await Promise.allSettled(
    ACCOUNTS.map(async (acct) => {
      const [charges, transfers] = await Promise.all([
        fetchAllCharges(acct.id, thirtyOneDaysAgo),
        acct.marketplace ? fetchAllTransfers(acct.id, thirtyOneDaysAgo) : Promise.resolve([]),
      ]);
      return { acct, charges, transfers };
    })
  );

  for (const result of accountResults) {
    if (result.status === 'rejected') {
      console.error('Account fetch failed:', result.reason?.message);
      continue;
    }
    const { acct, charges, transfers } = result.value;
    try {
      const succeeded = charges.filter(c => c.status === 'succeeded');
      const metrics = computeMetrics(succeeded, transfers, now);

      // Preserve all-time totals: use existing cache values if they're higher
      // (31-day window only captures recent data; all-time accumulates)
      const prev = existingCache[acct.name];
      if (prev) {
        metrics.net = Math.max(metrics.net, prev.net_cents || 0);
        metrics.gross = Math.max(metrics.gross, prev.gross_cents || 0);
        metrics.transfers = Math.max(metrics.transfers, prev.transfers_cents || 0);
        metrics.sold = Math.max(metrics.sold, prev.products_sold || 0);
      }
      metrics.cachedThrough = now;

      await upsertCache(acct.name, metrics);
      results[acct.name] = { net: metrics.net, d30: metrics.d30, d7: metrics.d7, sold: metrics.sold };
    } catch (e) {
      console.error(`Error processing ${acct.name}:`, e.message);
      results[acct.name] = { error: e.message };
    }
  }

  // Felix CM from Supabase purchases
  try {
    const pRes = await fetch(
      `${SUPABASE_URL}/rest/v1/personas?select=id&creator_id=eq.${FELIX_CREATOR_ID}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const personas = await pRes.json();
    if (Array.isArray(personas) && personas.length) {
      const ids = personas.map(p => p.id).join(',');
      const purchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/purchases?select=amount_cents,platform_fee_cents,created_at&persona_id=in.(${ids})&refunded_at=is.null`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const purchases = await purchRes.json();
      if (Array.isArray(purchases)) {
        const thirtyDaysAgo = now - 30 * 86400;
        const sevenDaysAgo = now - 7 * 86400;
        let net = 0, d30 = 0, d7 = 0, sold = 0, d30Sold = 0;
        const dailyMap = {};

        for (const p of purchases) {
          const earning = (p.amount_cents || 0) - (p.platform_fee_cents || 0);
          const ts = new Date(p.created_at).getTime() / 1000;
          const date = toCentralDate(ts);
          net += earning;
          sold++;
          if (ts >= thirtyDaysAgo) {
            dailyMap[date] = (dailyMap[date] || 0) + earning;
            d30 += earning;
            d30Sold++;
          }
          if (ts >= sevenDaysAgo) d7 += earning;
        }

        const daily = Object.entries(dailyMap)
          .map(([date, amount]) => ({ date, amount }))
          .sort((a, b) => a.date.localeCompare(b.date));

        const data = { net, gross: net, transfers: 0, sold, d7, d30, d30Sold, daily, cachedThrough: now };
        await upsertCache('felix_cm', data);
        results.felix_cm = { net, d30, d7, sold };
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
