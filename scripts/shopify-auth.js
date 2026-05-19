#!/usr/bin/env node
/**
 * Shopify OAuth Token Generator
 * ─────────────────────────────
 * Exchanges your Client ID + Secret for a permanent access token.
 *
 * BEFORE running this script:
 *   1. In your Shopify Partner Dashboard → Apps → your app
 *   2. Go to "App setup" → "URLs"
 *   3. Set "Allowed redirection URL(s)" to:
 *      http://localhost:3456/callback
 *   4. Save, then run: npm run auth
 *
 * What it does:
 *   1. Starts a local server on port 3456
 *   2. Prints an authorization URL — open it in your browser
 *   3. You click "Install" on Shopify
 *   4. Shopify redirects back, the script catches the code
 *   5. Exchanges code for a permanent access token
 *   6. Writes SHOPIFY_ACCESS_TOKEN to your .env automatically
 */

require('dotenv').config();
const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const readline = require('readline');

const CALLBACK_PORT = 3456;
const CALLBACK_URL  = `http://localhost:${CALLBACK_PORT}/callback`;
const ENV_PATH      = path.join(__dirname, '../.env');

const SCOPES = [
  'read_products', 'write_products',
  'read_orders', 'write_orders',
  'read_inventory', 'write_inventory',
  'read_fulfillments', 'write_fulfillments',
  'read_locations',
  'read_customers', 'write_customers',
  'read_draft_orders', 'write_draft_orders',
  'read_shipping',
  'read_reports'
].join(',');

// ── Helpers ───────────────────────────────────────────────
const ask = (question) => new Promise(resolve => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
});

function readEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) env[match[1].trim()] = match[2].trim();
  }
  return env;
}

function writeEnvKey(key, value) {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, content);
}

function exchangeCodeForToken(shopDomain, clientId, clientSecret, code) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ client_id: clientId, client_secret: clientSecret, code });
    const req = https.request({
      hostname: shopDomain,
      path:     '/admin/oauth/access_token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) resolve(parsed.access_token);
          else reject(new Error(parsed.error_description || JSON.stringify(parsed)));
        } catch (e) {
          reject(new Error('Bad response from Shopify: ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const SUCCESS_HTML = `<!DOCTYPE html><html>
<head><title>Dropship AI — Connected!</title>
<style>
  body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
    min-height:100vh;margin:0;background:#080b12;color:#e6edf3}
  .box{text-align:center;padding:48px 56px;border:1px solid #1a2332;border-radius:14px;background:#0d1117;max-width:420px}
  h2{color:#3fb950;font-size:22px;margin:16px 0 10px}
  p{color:#7d8590;font-size:14px;line-height:1.6}
  .tag{background:rgba(63,185,80,.1);border:1px solid rgba(63,185,80,.3);color:#3fb950;
    padding:6px 14px;border-radius:20px;font-size:13px;font-family:monospace;margin-top:16px;display:inline-block}
</style></head>
<body><div class="box">
  <div style="font-size:52px">✅</div>
  <h2>Store connected!</h2>
  <p>Your access token has been saved to <code>.env</code>.<br>You can close this tab.</p>
  <div class="tag">npm start</div>
</div></body></html>`;

const ERROR_HTML = (msg) => `<!DOCTYPE html><html>
<head><title>Auth Error</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#080b12;color:#e6edf3}
.box{text-align:center;padding:40px;border:1px solid #f85149;border-radius:12px;background:#0d1117;max-width:400px}
h2{color:#f85149}</style></head>
<body><div class="box"><div style="font-size:48px">❌</div>
<h2>Authorization failed</h2><p style="color:#7d8590">${msg}</p>
<p style="color:#7d8590;margin-top:12px">Close this tab and check the terminal.</p>
</div></body></html>`;

// ── Main ──────────────────────────────────────────────────
async function main() {
  console.log('\n🛒  Shopify OAuth Token Generator');
  console.log('═'.repeat(44) + '\n');

  console.log('⚠️  FIRST — make sure this redirect URL is added to your app:');
  console.log(`    ${CALLBACK_URL}\n`);
  console.log('Where to add it:');
  console.log('  Shopify Partner Dashboard → Apps → [your app]');
  console.log('  → App setup → URLs → Allowed redirection URL(s)\n');

  const ready = await ask('Have you added the redirect URL? (y/N): ');
  if (ready.toLowerCase() !== 'y') {
    console.log('\nAdd the redirect URL first, then run `npm run auth` again.\n');
    process.exit(0);
  }

  // Collect credentials
  const existingEnv = readEnv();

  let shopName     = existingEnv.SHOPIFY_SHOP_NAME || '';
  let clientId     = existingEnv.SHOPIFY_CLIENT_ID || existingEnv.SHOPIFY_API_KEY || '';
  let clientSecret = existingEnv.SHOPIFY_CLIENT_SECRET || existingEnv.SHOPIFY_API_SECRET || '';

  if (!shopName || shopName === 'your-store.myshopify.com') {
    shopName = await ask('Shop domain (e.g. mystore.myshopify.com): ');
  } else {
    console.log(`Shop: ${shopName}  ✓`);
  }

  if (!clientId) {
    clientId = await ask('Client ID: ');
  } else {
    console.log(`Client ID: ${clientId.substring(0, 8)}***  ✓`);
  }

  if (!clientSecret) {
    clientSecret = await ask('Client Secret (shpss_...): ');
  } else {
    console.log(`Client Secret: ${clientSecret.substring(0, 8)}***  ✓`);
  }

  // Normalize domain
  shopName = shopName.replace(/https?:\/\//, '').replace(/\/$/, '').trim();
  if (!shopName.includes('.')) shopName += '.myshopify.com';

  const state   = crypto.randomBytes(16).toString('hex');
  const authUrl = `https://${shopName}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(CALLBACK_URL)}` +
    `&state=${encodeURIComponent(state)}`;

  console.log('\n─'.repeat(44));
  console.log('📋 Open this URL in your browser:\n');
  console.log('  ' + authUrl);
  console.log('\n─'.repeat(44));
  console.log('⏳ Waiting for you to authorize in the browser...\n');

  // Start local callback server
  const accessToken = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith('/callback')) {
        res.writeHead(404); res.end(); return;
      }

      let url;
      try { url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`); }
      catch (_) { res.writeHead(400); res.end(); return; }

      const code   = url.searchParams.get('code');
      const rState = url.searchParams.get('state');
      const error  = url.searchParams.get('error');
      const errDesc = url.searchParams.get('error_description') || '';

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML(error + (errDesc ? ': ' + errDesc : '')));
        server.close();
        reject(new Error('Shopify denied authorization: ' + error));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML('No authorization code received.'));
        server.close();
        reject(new Error('No code in callback'));
        return;
      }

      if (rState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML('State mismatch — possible CSRF. Try again.'));
        server.close();
        reject(new Error('State parameter mismatch'));
        return;
      }

      console.log('✅ Authorization code received!');
      console.log('🔄 Exchanging for permanent access token...');

      try {
        const token = await exchangeCodeForToken(shopName, clientId, clientSecret, code);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SUCCESS_HTML);
        server.close();
        resolve(token);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML(err.message));
        server.close();
        reject(err);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      // silent — URL already printed above
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${CALLBACK_PORT} is busy. Stop other processes and try again.`));
      } else {
        reject(err);
      }
    });

    // 5 minute timeout
    setTimeout(() => {
      server.close();
      reject(new Error('Timed out after 5 minutes. Run `npm run auth` again.'));
    }, 5 * 60 * 1000);
  });

  // ── Save to .env ──────────────────────────────────────────
  writeEnvKey('SHOPIFY_SHOP_NAME',     shopName);
  writeEnvKey('SHOPIFY_CLIENT_ID',     clientId);
  writeEnvKey('SHOPIFY_CLIENT_SECRET', clientSecret);
  writeEnvKey('SHOPIFY_API_KEY',       clientId);       // legacy alias
  writeEnvKey('SHOPIFY_API_SECRET',    clientSecret);   // legacy alias
  writeEnvKey('SHOPIFY_ACCESS_TOKEN',  accessToken);

  console.log('\n🎉 Success! Saved to .env:\n');
  console.log(`   SHOPIFY_SHOP_NAME     = ${shopName}`);
  console.log(`   SHOPIFY_ACCESS_TOKEN  = ${accessToken.substring(0, 10)}***`);
  console.log('\nNext steps:');
  console.log('   npm run validate   ← test all connections');
  console.log('   npm start          ← launch your store\n');
}

main().catch(err => {
  console.error('\n❌ ' + err.message + '\n');
  process.exit(1);
});
