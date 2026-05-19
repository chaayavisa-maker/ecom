# 🤖 Dropship AI — Automated Shopify Dropshipping

**6 autonomous AI agents** run your dropshipping store 24/7.
Choose between **Grok (free)** or **Claude (paid)** as the AI brain.

---

## Quick Start

```bash
# 1. Install
npm install

# 2. Copy env template
cp .env.example .env

# 3. Get your Shopify access token (one-time)
npm run auth

# 4. Validate all connections
npm run validate

# 5. Launch
npm start
```

Open **http://localhost:3000** for the real-time dashboard.

---

## Getting Your Shopify Access Token

You have a Client ID + Secret (`shpss_...`) from your Shopify app.
The `npm run auth` script converts these into a permanent access token automatically.

### Step 1 — Add the redirect URL to your Shopify app

1. Go to **Shopify Partner Dashboard** → Apps → your app
2. Click **"App setup"**
3. Under **"URLs"** → **"Allowed redirection URL(s)"** add:
   ```
   http://localhost:3456/callback
   ```
4. Click **Save**

### Step 2 — Run the auth script

```bash
npm run auth
```

The script will:
- Ask for your shop domain, Client ID, and Secret (or read from `.env`)
- Print an authorization URL — open it in your browser
- You click **Install** on Shopify
- Token is written to `.env` automatically as `SHOPIFY_ACCESS_TOKEN`

### Step 3 — Verify it worked

```bash
npm run validate
```

---

## AI Provider Config

```bash
# FREE — Grok (xAI)
AI_PROVIDER=grok
GROK_API_KEY=xai-your-key       # https://console.x.ai
GROK_MODEL=grok-3               # or grok-3-mini

# PAID — Claude (Anthropic)
AI_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-xxx    # https://console.anthropic.com
CLAUDE_MODEL=claude-sonnet-4-20250514
```

Switch at runtime via dashboard or API — no restart needed:
```bash
curl -X POST http://localhost:3000/api/agents/switch-provider \
  -H "Content-Type: application/json" \
  -d '{"provider":"grok"}'
```

---

## The 6 AI Agents

| Agent | What it does | Schedule |
|---|---|---|
| 🔍 **Research** | Finds trending niches, scores products 1–100 | Every 6h |
| 📝 **Listing** | Writes SEO titles, HTML descriptions, sets prices | After Research |
| 💰 **Pricing** | Monitors cost changes, adjusts margins | Every 1h |
| 📦 **Fulfillment** | Processes paid orders, places with supplier | Every 15m |
| 🏷️ **Inventory** | Syncs stock, drafts out-of-stock products | Every 30m |
| 💬 **Support** | Drafts replies to customer order notes | Every 1h |

---

## Project Structure

```
shopify-dropship-ai/
├── server.js
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── scripts/
│   ├── shopify-auth.js    ← OAuth token generator  (npm run auth)
│   ├── setup.js           ← Interactive setup wizard
│   └── validate.js        ← Connection validator    (npm run validate)
├── src/
│   ├── agents/
│   │   ├── productResearchAgent.js
│   │   ├── listingAgent.js
│   │   ├── pricingAgent.js
│   │   ├── fulfillmentAgent.js
│   │   ├── inventoryAgent.js
│   │   └── supportAgent.js
│   ├── shopify/
│   │   ├── client.js
│   │   ├── products.js
│   │   └── orders.js
│   ├── suppliers/
│   │   └── aliexpress.js
│   ├── scheduler/
│   │   └── cron.js
│   ├── webhooks/
│   │   └── handler.js
│   ├── middleware/
│   │   └── routes.js
│   └── utils/
│       ├── aiProvider.js  ← Universal Grok/Claude wrapper
│       ├── analytics.js
│       └── logger.js
└── public/
    └── dashboard.html
```

---

## All NPM Scripts

```bash
npm run auth       # Get Shopify access token from Client ID + Secret
npm run setup      # Interactive .env setup wizard
npm run validate   # Test all API connections
npm start          # Launch server + all agents
npm run dev        # Launch with auto-reload (nodemon)
npm run agents     # Run scheduler only (no HTTP server)
```

---

## API Endpoints

```
POST /api/agents/research
POST /api/agents/research-and-list
POST /api/agents/pricing
POST /api/agents/fulfillment
POST /api/agents/inventory
POST /api/agents/support
POST /api/agents/switch-provider    { "provider": "grok" | "claude" }

GET  /api/dashboard/stats
GET  /api/dashboard/orders
GET  /api/analytics/report?days=30
GET  /api/analytics/insights?days=30
GET  /api/products
PUT  /api/products/:id/price
DELETE /api/products/:id
GET  /api/health
POST /webhooks/:resource/:event
```

---

## Deployment

### Docker
```bash
docker-compose up -d
```

### PM2
```bash
npm i -g pm2
pm2 start server.js --name dropship-ai
pm2 save && pm2 startup
```

### Cloud (Railway / Render / Fly.io)
Push to GitHub → connect repo → add env vars → deploy.
Set `BASE_URL` to your deployment URL so webhooks auto-register.

---

## Pricing Formula

```
Selling price = (Cost + Shipping buffer) × (1 + Markup%)
Rounded to psychological pricing: ceil(price) - 0.01

Example: $8 product, 200% markup, $5 shipping buffer
  = ($8 + $5) × 3 = $39 → $38.99
  Compare-at: $38.99 × 1.4 = $54.99 (shown as crossed out)
```

---

MIT License
