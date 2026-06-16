# Dropship AI — Update Guide

## What changed and why

| File | Change | Why |
|---|---|---|
| `.env` | `AUTO_PUBLISH_PRODUCTS=true` | Products were being created as drafts and never going live — zero sales possible |
| `.env` | `BASE_URL=` (cleared) | Was pointing to `localhost` — Shopify can't reach that, causing webhook errors on every startup |
| `.env` | `SHIPPING_BUFFER=5` → `SHIPPING_BUFFER_USD=5` | Key name corrected to match what listingAgent reads |
| `.env` | `NICHE_EXPIRY_DAYS=14` | New setting — controls how long approved niches stay active |
| `src/config/niches.js` | **New file** | Manages niche state (pending → approved → expired) in `niche.config.json` |
| `src/agents/productResearchAgent.js` | Niche selection rewritten | Now reads from `niche.config.json`; queues AI suggestions for your approval instead of using them blindly |
| `src/agents/listingAgent.js` | One-line fix | `status` now uses `AUTO_PUBLISH_PRODUCTS` env var |
| `scripts/manage-niches.js` | **New file** | Interactive CLI to approve/reject AI niche suggestions |
| `scripts/status.js` | **New file** | Headless store health report — live Shopify stats, niche state, recent logs |
| `package.json` | Two new scripts | `npm run niches` and `npm run status` |

---

## How to apply

Copy each file from this archive into your project, **maintaining the same folder structure**:

```
your-project/
├── .env                                ← replace
├── package.json                        ← replace
├── src/
│   ├── config/
│   │   └── niches.js                  ← new
│   └── agents/
│       ├── productResearchAgent.js    ← replace
│       └── listingAgent.js            ← replace
└── scripts/
    ├── manage-niches.js               ← new
    └── status.js                      ← new
```

No `npm install` needed — no new dependencies.

---

## First-time setup after update

### Step 1 — Start the server (or let it run)
```bash
npm start
```
On the first research cycle (or immediately if you trigger it manually), the agent will:
- Detect there are no approved niches yet
- Ask the AI for 5 suggestions
- Save them to `niche.config.json` as `pending`
- Log: `💡 AI suggested 5 niche(s) — run npm run niches to approve them`
- Fall back to safe defaults for this run so nothing stalls

### Step 2 — Approve niches
```bash
npm run niches
```
You'll see the AI suggestions and press `a` (approve), `r` (reject), or `s` (skip) for each.
Approved niches take effect on the next research cycle (every 6 hours).

You can also type any niche manually — it'll be approved instantly.

### Step 3 — Check everything is working
```bash
npm run status
```
Shows:
- Which niches are active and when they expire
- How many pending niche suggestions await review
- Live Shopify product count + last 7 days revenue
- Last 30 log entries

---

## Ongoing operation

**Every 6 hours** the research agent:
1. Searches AliExpress for top products in your approved niches
2. Scores them with AI (demand, margin, competition)
3. Passes winners to the listing agent → creates products on Shopify as **active** (live)

**Every 14 days** approved niches expire → agent generates new suggestions → you run `npm run niches` again.

**Daily at 8am** a health report runs and logs revenue, order count, fulfillment rate, and AI insights.

---

## Niche config file (niche.config.json)

Auto-created at project root on first run. You can also edit it by hand:

```json
{
  "niches": [
    { "name": "portable blenders", "status": "approved", "approvedAt": "2026-06-16T..." },
    { "name": "cat water fountains", "status": "pending", "suggestedAt": "2026-06-16T..." },
    { "name": "fidget rings", "status": "rejected" }
  ]
}
```

Statuses: `pending` | `approved` | `rejected`

Rejected niches are permanently blacklisted from AI suggestions.
