# Felix Craft Dashboard — PRD

## Overview
Build a public business dashboard at `/dashboard` on felixcraft.ai showing real-time business metrics for The Masinov Company.

## Architecture
- Static site on Vercel (no framework — plain HTML/CSS/JS)
- Serverless API functions in `/api/` (Node.js, ES modules)
- Existing design system: dark theme with CSS variables defined in `index.html` root (copy them)
- Use the same fonts (Inter + Fraunces) and nav structure as `index.html`

## Pages

### `/dashboard.html` (or `/dashboard/index.html`)
Public dashboard page matching the existing site design (dark theme, gold accent `#c4a35a`).

**Sections:**

#### 1. Revenue (Stripe)
- Show daily revenue for the last 30 days as a line/bar chart
- Use Chart.js (CDN) for charting
- Show total revenue for: last 7 days, last 30 days, all time
- Revenue = **Net Volume** (gross minus refunds and payouts to creators)
- Data comes from `/api/dashboard-data.js`

#### 2. Crypto Treasury
- Show holdings of masinov.base.eth (`0x114d78163Fa1AB2488A5A2281317953C8679f508`) on Base chain:
  - ETH balance (native)
  - USDC balance (contract: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals)
  - FELIX balance (contract: `0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07`, 18 decimals)
- Show USD value for each (use CoinGecko or similar free API for ETH price; USDC = $1; skip FELIX USD price for now)

#### 3. FELIX Token Stats
- **Burned:** FELIX balance held by `0x000000000000000000000000000000000000dEaD` (18 decimals)
- **Sold:** hardcode 0 for now
- Show as big number cards

#### 4. Suggested additions (implement these too)
- **Products sold** — total count of successful Stripe payments across all accounts
- **Claw Mart creators** — (hardcode for now, we'll make dynamic later) number of creators on the platform

## API Endpoints

### `GET /api/dashboard-data.js`
Returns JSON with all dashboard data. Fetches from:

**Stripe (server-side, uses STRIPE_SECRET_KEY env var):**
- Query balance transactions for last 30 days across all Masinov Stripe accounts:
  - `acct_1SxS6yRfMsviJLHg` (Claw Mart — use net)
  - `acct_1SwiqtDtmukBWxkL` (felixcraft.ai book sales)
  - `acct_1SwUyqDAsOYrsvx8` (Polylogue)
  - `acct_1SysljRnJP71h2KV` (Felix CM earnings)
- Group by day, return array of `{ date, amount }` (cents)
- Also return total counts of successful charges (products sold)

**Base Chain (server-side, use public RPC `https://mainnet.base.org`):**
- ETH balance: `eth_getBalance`
- ERC-20 balances: `eth_call` with `balanceOf(address)` selector `0x70a08231`
- Query for treasury wallet AND dead address (for burn count)

**Response shape:**
```json
{
  "revenue": {
    "daily": [{ "date": "2026-02-20", "amount": 1234 }],
    "total7d": 5000,
    "total30d": 20000,
    "allTime": 100000
  },
  "treasury": {
    "eth": "0.5",
    "usdc": "1234.56",
    "felix": "500000",
    "ethUsd": 1500.00
  },
  "token": {
    "burned": "250000",
    "sold": "0"
  },
  "stats": {
    "productsSold": 42,
    "clawmartCreators": 8
  }
}
```

## Design Notes
- Match existing dark theme exactly (copy CSS vars from index.html)
- Cards with subtle borders (`var(--border)`) and surface backgrounds (`var(--surface)`)
- Gold accent (`var(--accent)`) for chart lines and highlights
- Responsive — works on mobile
- Loading states while data fetches
- Add "Dashboard" link to nav in index.html
- Nav should be consistent with index.html (copy the nav HTML)

## Environment Variables Needed (already on Vercel)
- `STRIPE_SECRET_KEY` — already set
- No API key needed for Base RPC (public endpoint)
- No API key needed for CoinGecko (free tier)

## Files to Create/Modify
1. **CREATE** `dashboard.html` — the dashboard page
2. **CREATE** `api/dashboard-data.js` — serverless data endpoint
3. **MODIFY** `index.html` — add "Dashboard" link to nav
4. **MODIFY** `vercel.json` — add rewrite for dashboard-data API
5. **MODIFY** `package.json` — no new deps needed (Stripe already installed; use fetch for RPC/CoinGecko)

## Important Constraints
- All Stripe API calls use the default key from env, with `Stripe-Account` header for non-default accounts
- Revenue must be NET (after refunds), not gross
- ERC-20 balance reads use raw `eth_call` — no ethers.js dependency needed
- Chart.js loaded from CDN, not npm
- The site has NO build step — it's all static HTML served by Vercel
- Keep the API response cached for 5 minutes (Cache-Control header) to avoid hammering Stripe/RPC
