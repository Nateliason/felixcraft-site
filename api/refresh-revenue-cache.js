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

export default async function handler(req, res) {
  // Auth: Vercel cron sets this header automatically, or use CRON_SECRET
  const auth = req.headers.authorization;
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  if (!isVercelCron && CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = Math.floor(Date.now() / 1000);
  const results = {};

  // Process each Stripe account
  for (const acct of ACCOUNTS) {
    try {
      const charges = await fetchAllCharges(acct.id, null);
      const succeeded = charges.filter(c => c.status === 'succeeded');
      const gross = succeeded.reduce((s, c) => s + c.amount - (c.amount_refunded || 0), 0);

      let transfers = 0;
      if (acct.marketplace) {
        const allTransfers = await fetchAllTransfers(acct.id, null);
        transfers = allTransfers.reduce((s, t) => s + t.amount, 0);
      }

      const data = {
        net: gross - transfers,
        gross,
        transfers,
        sold: succeeded.length,
        cachedThrough: now,
      };

      await upsertCache(acct.name, data);
      results[acct.name] = data;
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
        let net = 0, sold = 0;
        for (const p of purchases) {
          net += (p.amount_cents || 0) - (p.platform_fee_cents || 0);
          sold++;
        }
        const data = { net, gross: net, transfers: 0, sold, cachedThrough: now };
        await upsertCache('felix_cm', data);
        results.felix_cm = data;
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
