const express = require('express');
const Stripe = require('stripe');
const puppeteer = require('puppeteer');

const app = express();

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE = 'https://services.leadconnectorhq.com';
const SIGNWELL_BASE = 'https://www.signwell.com/api/v1';

// /stripe-webhook needs the raw body for signature verification — register
// this route BEFORE the global express.json() middleware
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  if (event.type !== 'invoice.paid' && event.type !== 'invoice_payment.paid') {
    return res.status(200).json({ received: true });
  }

  // event.account is set when this event originates from a connected account
  // (e.g. via Stripe Connect). Retrieves must be scoped to that account, or
  // they'll look in the platform account's namespace and fail to find anything.
  // Pass undefined rather than {} — stripe-node's arg parser can't tell an
  // empty options object apart from a stray extra argument.
  const stripeOpts = event.account ? { stripeAccount: event.account } : undefined;

  // invoice_payment.paid's data.object is an InvoicePayment, not the Invoice
  // itself — it only carries the invoice ID, so fetch the full invoice to get
  // the customer (and keep the rest of this handler shape-agnostic).
  let invoice;
  if (event.type === 'invoice_payment.paid') {
    invoice = await stripe.invoices.retrieve(event.data.object.invoice, stripeOpts);
  } else {
    invoice = event.data.object;
  }
  const customerId = invoice.customer;

  // Fetch the customer from Stripe to get their email
  const customer = await stripe.customers.retrieve(customerId, stripeOpts);
  const email = customer.email;

  if (!email) {
    console.error(`No email on Stripe customer ${customerId}`);
    return res.status(200).json({ received: true });
  }

  console.log(`${event.type} for ${email}, invoice ${invoice.id}`);

  const prefix = findClientPrefixForStripeAccount(event.account);
  const { ghlApiKey, ghlLocationId } = resolveGhlConfig(prefix);

  // Look up the contact in GHL by email
  const searchRes = await fetch(
    `${GHL_BASE}/contacts/?query=${encodeURIComponent(email)}&locationId=${ghlLocationId}`,
    {
      headers: {
        Authorization: `Bearer ${ghlApiKey}`,
        Version: '2021-07-28',
      },
    }
  );

  if (!searchRes.ok) {
    const body = await searchRes.text();
    console.error('GHL contact search failed:', searchRes.status, body);
    return res.status(500).json({ error: 'GHL contact search failed' });
  }

  const searchData = await searchRes.json();
  const contact = searchData.contacts?.[0];

  if (!contact) {
    console.error(`No GHL contact found for email: ${email}`);
    return res.status(200).json({ received: true });
  }

  // Merge the new tag with any existing tags to avoid overwriting them
  const existingTags = contact.tags || [];
  const updatedTags = Array.from(new Set([...existingTags, 'Payment Received']));

  const updateRes = await fetch(`${GHL_BASE}/contacts/${contact.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${ghlApiKey}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tags: updatedTags }),
  });

  if (!updateRes.ok) {
    const body = await updateRes.text();
    console.error('GHL contact update failed:', updateRes.status, body);
    return res.status(500).json({ error: 'GHL contact update failed' });
  }

  console.log(`Tagged GHL contact ${contact.id} (${email}) with "Payment Received"`);
  return res.status(200).json({ received: true });
});

// Global JSON parser for all other routes
app.use(express.json());

// Runtime store for Stripe Connect account IDs acquired via OAuth.
// Seeded from env vars on first lookup; also populated by /connect/callback.
const connectedAccounts = new Map();

// Resolves the per-client GHL credentials for a given [PREFIX] (e.g. "CAT_PETERS"),
// falling back to the default env vars when no per-client override exists.
function resolveGhlConfig(prefix) {
  return {
    ghlApiKey: (prefix && process.env[`${prefix}_GHL_API_KEY`]) || GHL_API_KEY,
    ghlLocationId: (prefix && process.env[`${prefix}_GHL_LOCATION_ID`]) || GHL_LOCATION_ID,
    ghlWebhookUrl: (prefix && process.env[`${prefix}_GHL_WEBHOOK`]) || process.env.GHL_WORKFLOW_WEBHOOK_URL,
  };
}

function getClientConfig(clientId) {
  const prefix = clientId ? clientId.toUpperCase().replace(/-/g, '_') : '';
  const envKey = prefix ? `${prefix}_STRIPE_ACCOUNT_ID` : null;
  const fromMap = prefix ? connectedAccounts.get(clientId) : undefined;
  const fromEnv = envKey ? process.env[envKey] : undefined;
  const stripeAccountId = (prefix && (fromMap || fromEnv)) || null;
  console.log(
    `getClientConfig(clientId=${JSON.stringify(clientId)}): prefix=${JSON.stringify(prefix)}, ` +
    `envKey=${JSON.stringify(envKey)}, connectedAccounts.get(clientId)=${JSON.stringify(fromMap)}, ` +
    `process.env[envKey]=${fromEnv ? JSON.stringify(fromEnv) : String(fromEnv)}, ` +
    `resolved stripeAccountId=${JSON.stringify(stripeAccountId)}`
  );
  return {
    // When a Connect account is linked, always use the platform key + stripeAccount header.
    // Otherwise fall back to the per-client restricted key (legacy) then the platform key.
    stripeKey:
      stripeAccountId
        ? process.env.STRIPE_SECRET_KEY
        : (prefix && process.env[`${prefix}_STRIPE_KEY`]) || process.env.STRIPE_SECRET_KEY,
    stripeAccountId,
    ...resolveGhlConfig(prefix),
  };
}

// /stripe-webhook only has a Stripe connected account ID (event.account), not a
// clientId, so recover the [PREFIX] used everywhere else by reverse-matching
// it against the same connectedAccounts map / *_STRIPE_ACCOUNT_ID env vars
// that getClientConfig() reads.
function findClientPrefixForStripeAccount(stripeAccountId) {
  if (!stripeAccountId) return null;
  for (const [clientId, acctId] of connectedAccounts.entries()) {
    if (acctId === stripeAccountId) return clientId.toUpperCase().replace(/-/g, '_');
  }
  const suffix = '_STRIPE_ACCOUNT_ID';
  for (const key of Object.keys(process.env)) {
    if (key.endsWith(suffix) && process.env[key] === stripeAccountId) {
      return key.slice(0, -suffix.length);
    }
  }
  return null;
}

// Accepts null/undefined, the literal string "null", raw numbers ("1", 1),
// and formatted currency strings ("$1.00", "$1,000"). Returns cents, or
// null if no valid positive amount could be parsed.
function parseInvestmentAmountCents(investment_amount) {
  if (investment_amount === null || investment_amount === undefined) return null;
  const str = String(investment_amount).trim();
  if (!str || str.toLowerCase() === 'null') return null;

  const cleaned = str.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;

  const dollars = parseFloat(cleaned);
  if (isNaN(dollars) || dollars <= 0) return null;

  return Math.round(dollars * 100);
}

app.post('/webhook', async (req, res) => {
  try {
    console.log('GHL webhook payload:', JSON.stringify(req.body, null, 2));

    const { clientId, email, name, investment_amount } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Missing required field: email' });
    }

    const amountCents = parseInvestmentAmountCents(investment_amount);
    if (amountCents === null) {
      return res.status(400).json({ error: 'investment_amount must be a positive number' });
    }

    const { stripeKey, ghlWebhookUrl, stripeAccountId } = getClientConfig(clientId);
    const stripeClient = Stripe(stripeKey);
    // stripe-node's arg parser can't distinguish an empty options object from a
    // stray extra argument (it requires at least one recognized key to treat it
    // as options), so pass undefined rather than {} when there's no Connect account.
    const stripeOpts = stripeAccountId ? { stripeAccount: stripeAccountId } : undefined;
    console.log(
      stripeAccountId
        ? `Using Stripe Connect account ${stripeAccountId} for clientId "${clientId}", GHL webhook: ${ghlWebhookUrl}`
        : `Using Stripe key for clientId "${clientId || 'default'}", GHL webhook: ${ghlWebhookUrl}`
    );

    // Find or create a Stripe customer by email
    console.log('stripeAccountId:', stripeAccountId, 'stripeOpts:', JSON.stringify(stripeOpts));
    const existingCustomers = await stripeClient.customers.list({ email, limit: 1 }, stripeOpts);
    let customer;
    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
    } else {
      customer = await stripeClient.customers.create({ email, name: name || undefined }, stripeOpts);
    }

    // Create the invoice first so the item can be explicitly attached to it
    const invoice = await stripeClient.invoices.create({
      customer: customer.id,
      collection_method: 'send_invoice',
      days_until_due: 30,
      auto_advance: true,
    }, stripeOpts);

    await stripeClient.invoiceItems.create({
      customer: customer.id,
      invoice: invoice.id,
      amount: amountCents,
      currency: 'usd',
      description: `Investment — ${name || email}`,
    }, stripeOpts);

    await stripeClient.invoices.sendInvoice(invoice.id, {}, stripeOpts);

    console.log(`Invoice ${invoice.id} sent to ${email} for $${(amountCents / 100).toFixed(2)}`);

    return res.status(200).json({ success: true, invoiceId: invoice.id });
  } catch (err) {
    console.error('/webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// --- Contract PDF generation ---

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchContractTemplate(clientId, { clientName, startDate, investmentAmount, packageName, customTerms }) {
  const url = `https://pub-bc05478d0dc049fbb076e6e51d59fe82.r2.dev/clients/${encodeURIComponent(clientId)}/contract-template.html`;
  console.log(`Fetching contract template: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    console.error(`Contract template fetch failed for clientId "${clientId}": ${res.status} ${res.statusText}, url=${url}, body=${body}`);
    throw new Error(`Failed to fetch contract template for clientId "${clientId}": ${res.status}`);
  }
  const normalizedTerms = (customTerms || '').replace(/\\n/g, '\n');
  return (await res.text())
    .replace(/\{\{client_name\}\}/g, escapeHtml(clientName))
    .replace(/\{\{start_date\}\}/g, escapeHtml(startDate))
    .replace(/\{\{investment_amount\}\}/g, escapeHtml(investmentAmount))
    .replace(/\{\{package_name\}\}/g, escapeHtml(packageName || ''))
    .replace(/\{\{custom_terms\}\}/g, escapeHtml(normalizedTerms))
    .replace('</head>', '<style>.logo img{max-height:80px;width:auto;}.coach-sig img{max-height:48px;width:auto;}</style></head>');
}

async function generateContractPDF(html) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="font-size:9pt;color:#888;padding:0 72px;width:100%;font-family:Arial,sans-serif;">
        <span class="pageNumber"></span> of <span class="totalPages"></span>
      </div>`,
      margin: { top: '1in', right: '1in', bottom: '0.75in', left: '1in' },
    });
    return Buffer.from(pdf);
  } finally {
    if (browser) await browser.close();
  }
}

const triggeredDocuments = new Set();
const documentClientMap = new Map();

async function triggerGhlWorkflow({ email, name, documentId }) {
  if (triggeredDocuments.has(documentId)) {
    console.log(`GHL workflow already triggered for document ${documentId}, skipping`);
    return false;
  }
  triggeredDocuments.add(documentId);
  const clientId = documentClientMap.get(documentId);
  const { ghlWebhookUrl: webhookUrl } = getClientConfig(clientId);
  if (!webhookUrl) throw new Error('No GHL webhook URL configured (set GHL_WORKFLOW_WEBHOOK_URL or a per-client variant)');
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: name || '', document_id: documentId }),
  });
  if (!res.ok) throw new Error(`GHL workflow trigger failed: ${res.status} ${await res.text()}`);
  console.log(`Triggered GHL workflow for ${email}, document ${documentId}`);
  return true;
}

async function fetchSignwellDocument(documentId) {
  const res = await fetch(`${SIGNWELL_BASE}/documents/${documentId}`, {
    headers: { 'X-Api-Key': process.env.SIGNWELL_API_KEY },
  });
  if (!res.ok) throw new Error(`SignWell API error: ${res.status} ${await res.text()}`);
  return res.json();
}

function pollUntilSigned(documentId) {
  const INTERVAL_MS = 30 * 1000;
  const TIMEOUT_MS = 24 * 60 * 60 * 1000;
  const startTime = Date.now();

  async function attempt() {
    if (triggeredDocuments.has(documentId)) {
      console.log(`Polling stopped for document ${documentId}: already triggered`);
      return;
    }
    if (Date.now() - startTime >= TIMEOUT_MS) {
      console.log(`Polling timed out for document ${documentId} after 24 hours`);
      return;
    }
    try {
      const doc = await fetchSignwellDocument(documentId);
      if (doc.status?.toLowerCase() === 'completed') {
        const recipient = doc.recipients?.[0];
        if (recipient?.email) {
          await triggerGhlWorkflow({ email: recipient.email, name: recipient.name, documentId });
        } else {
          console.error(`Polling: document ${documentId} completed but has no recipient email`);
        }
        return;
      }
      console.log(`Polling document ${documentId}: status=${doc.status}, next check in 30s`);
    } catch (err) {
      console.error(`Polling error for document ${documentId}:`, err.message);
    }
    setTimeout(attempt, INTERVAL_MS);
  }

  console.log(`Started polling for document ${documentId}`);
  setTimeout(attempt, INTERVAL_MS);
}

async function ghlAddTag(email, tag, clientId) {
  const prefix = clientId ? clientId.toUpperCase().replace(/-/g, '_') : '';
  const { ghlApiKey, ghlLocationId } = resolveGhlConfig(prefix);
  const searchRes = await fetch(
    `${GHL_BASE}/contacts/?query=${encodeURIComponent(email)}&locationId=${ghlLocationId}`,
    { headers: { Authorization: `Bearer ${ghlApiKey}`, Version: '2021-07-28' } }
  );
  if (!searchRes.ok) throw new Error(`GHL contact search failed: ${searchRes.status} ${await searchRes.text()}`);
  const { contacts } = await searchRes.json();
  const contact = contacts?.[0];
  if (!contact) throw new Error(`No GHL contact found for email: ${email}`);
  const updatedTags = Array.from(new Set([...(contact.tags || []), tag]));
  const updateRes = await fetch(`${GHL_BASE}/contacts/${contact.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${ghlApiKey}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: updatedTags }),
  });
  if (!updateRes.ok) throw new Error(`GHL contact update failed: ${updateRes.status} ${await updateRes.text()}`);
  console.log(`Tagged GHL contact ${contact.id} (${email}) with "${tag}"`);
}

app.post('/generate-contract', async (req, res) => {
  const { clientId, clientName, investmentAmount, startDate, packageName, customTerms } = req.body;
  if (!clientId || !clientName || !investmentAmount || !startDate) {
    return res.status(400).json({ error: 'Missing required fields: clientId, clientName, investmentAmount, startDate' });
  }
  try {
    const html = await fetchContractTemplate(clientId, { clientName, startDate, investmentAmount, packageName, customTerms });
    const pdf = await generateContractPDF(html);
    const safeName = clientName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="coaching-contract-${safeName}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('PDF generation failed:', err.message);
    res.status(500).json({ error: 'PDF generation failed', details: err.message });
  }
});

app.post('/send-contract', async (req, res) => {
  const { clientId, clientName, clientEmail, investmentAmount, startDate, packageName, customTerms } = req.body;
  if (!clientId || !clientName || !clientEmail || !investmentAmount || !startDate) {
    return res.status(400).json({ error: 'Missing required fields: clientId, clientName, clientEmail, investmentAmount, startDate' });
  }

  let pdf;
  try {
    const html = await fetchContractTemplate(clientId, { clientName, startDate, investmentAmount, packageName, customTerms });
    pdf = await generateContractPDF(html);
  } catch (err) {
    console.error('PDF generation failed:', err.message);
    return res.status(500).json({ error: 'PDF generation failed', details: err.message });
  }

  const safeName = clientName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const prefix = clientId.toUpperCase().replace(/-/g, '_');
  const coachName = process.env[`${prefix}_COACH_NAME`] || process.env.COACH_NAME || 'Hi Buy Book';
  const coachEmail = process.env[`${prefix}_COACH_EMAIL`] || process.env.COACH_EMAIL;
  const ccRecipients = coachEmail ? [{ email: coachEmail }] : [];
  const payload = {
    name: `Coaching Agreement — ${clientName}`,
    files: [{ name: `coaching-contract-${safeName}.pdf`, file_base64: pdf.toString('base64') }],
    recipients: [{ id: '1', name: clientName, email: clientEmail }],
    ...(ccRecipients.length > 0 && { ccs: ccRecipients }),
    custom_requester_name: coachName,
    custom_requester_email: coachEmail,
    fields: [[
      { type: 'signature', recipient_id: '1', page: 2, x: 72, y: 650, width: 300, height: 80 },
    ]],
    send_emails: true,
    callback_url: 'https://ghl-stripe-webhook-production.up.railway.app/signwell-webhook',
  };
  console.log('SignWell request body:', JSON.stringify({ ...payload, files: '[omitted]' }, null, 2));
  const signwellRes = await fetch(`${SIGNWELL_BASE}/documents/`, {
    method: 'POST',
    headers: { 'X-Api-Key': process.env.SIGNWELL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!signwellRes.ok) {
    const body = await signwellRes.text();
    console.error('SignWell API error:', signwellRes.status, body);
    return res.status(500).json({ error: 'Failed to send contract via SignWell', details: body });
  }

  const doc = await signwellRes.json();
  console.log(`Contract sent to ${clientEmail} via SignWell, document ID: ${doc.id}`);
  documentClientMap.set(doc.id, clientId);
  pollUntilSigned(doc.id);
  return res.status(200).json({
    success: true,
    documentId: doc.id,
    signingUrl: doc.recipients?.[0]?.signing_url,
  });
});

app.post('/signwell-webhook', async (req, res) => {
  res.status(200).json({ received: true });

  const { event_type, document } = req.body;
  if (event_type !== 'document_completed') return;

  const recipient = document?.recipients?.[0];
  if (!recipient?.email) {
    console.error('SignWell webhook: no recipient email on completed document', document?.id);
    return;
  }

  console.log(`Contract signed by ${recipient.email}, document ${document.id}`);
  try {
    await triggerGhlWorkflow({ email: recipient.email, name: recipient.name, documentId: document.id });
  } catch (err) {
    console.error('SignWell webhook GHL trigger failed:', err.message);
  }
});

// Manual status check — also usable from GHL as a fallback
app.get('/check-contract/:documentId', async (req, res) => {
  const { documentId } = req.params;
  try {
    const doc = await fetchSignwellDocument(documentId);
    const status = doc.status;
    console.log(`Polled document ${documentId}: status=${status}`);

    if (status?.toLowerCase() === 'completed') {
      const recipient = doc.recipients?.[0];
      if (!recipient?.email) {
        return res.status(200).json({ status, triggered: false, reason: 'no recipient email on document' });
      }
      const triggered = await triggerGhlWorkflow({ email: recipient.email, name: recipient.name, documentId });
      return res.status(200).json({ status, triggered, email: recipient.email });
    }

    return res.status(200).json({ status, triggered: false });
  } catch (err) {
    console.error('check-contract error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// --- Stripe Connect OAuth ---

app.get('/connect/oauth', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId query param required' });
  const stripeClientId = process.env.STRIPE_CLIENT_ID;
  if (!stripeClientId) return res.status(500).json({ error: 'STRIPE_CLIENT_ID env var not set' });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: stripeClientId,
    scope: 'read_write',
    state: clientId,
  });
  res.redirect(`https://connect.stripe.com/oauth/authorize?${params}`);
});

app.get('/connect/callback', async (req, res) => {
  const { code, state: clientId, error, error_description } = req.query;
  if (error) return res.status(400).json({ error: error_description || error });
  if (!code || !clientId) return res.status(400).json({ error: 'Missing code or state param' });

  const tokenRes = await fetch('https://connect.stripe.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_secret: process.env.STRIPE_SECRET_KEY,
      code,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    console.error('Stripe Connect token exchange failed:', tokenRes.status, body);
    return res.status(502).json({ error: 'Token exchange failed', details: body });
  }

  const token = await tokenRes.json();
  const stripeAccountId = token.stripe_user_id;
  const prefix = clientId.toUpperCase().replace(/-/g, '_');

  connectedAccounts.set(clientId, stripeAccountId);
  console.log(`Stripe Connect account linked for clientId "${clientId}": ${stripeAccountId}`);
  console.log(`Persist this by setting env var: ${prefix}_STRIPE_ACCOUNT_ID=${stripeAccountId}`);

  return res.json({ success: true, clientId, stripeAccountId, envVar: `${prefix}_STRIPE_ACCOUNT_ID` });
});

const BASE_URL = 'https://ghl-stripe-webhook-production.up.railway.app';

app.get('/connect/onboard', async (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId query param required' });

  const prefix = clientId.toUpperCase().replace(/-/g, '_');
  let stripeAccountId = connectedAccounts.get(clientId) || process.env[`${prefix}_STRIPE_ACCOUNT_ID`];

  if (!stripeAccountId) {
    const account = await stripe.accounts.create({ type: 'express' });
    stripeAccountId = account.id;
    connectedAccounts.set(clientId, stripeAccountId);
    console.log(`Created Stripe Connect Express account for clientId "${clientId}": ${stripeAccountId}`);
    console.log(`Persist by setting env var: ${prefix}_STRIPE_ACCOUNT_ID=${stripeAccountId}`);
  }

  const accountLink = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: `${BASE_URL}/connect/onboard?clientId=${encodeURIComponent(clientId)}`,
    return_url: `${BASE_URL}/connect/complete?clientId=${encodeURIComponent(clientId)}`,
    type: 'account_onboarding',
  });

  return res.json({ url: accountLink.url, stripeAccountId, envVar: `${prefix}_STRIPE_ACCOUNT_ID` });
});

app.get('/connect/complete', (req, res) => {
  const { clientId } = req.query;
  res.json({ success: true, message: `Stripe Connect onboarding complete for clientId "${clientId}". You may close this window.` });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/debug-env', (req, res) => {
  const keys = [
    'GHL_WORKFLOW_WEBHOOK_URL', 'GHL_API_KEY', 'GHL_LOCATION_ID',
    'SIGNWELL_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CLIENT_ID',
  ];
  const result = {};
  for (const key of keys) {
    result[key] = process.env[key] ? 'set' : 'MISSING';
  }
  result.connectedAccounts = Object.fromEntries(connectedAccounts);

  const { clientId } = req.query;
  if (clientId) {
    const config = getClientConfig(clientId);
    result.clientConfig = {
      clientId,
      stripeAccountId: config.stripeAccountId,
      stripeKeySource: config.stripeAccountId
        ? 'STRIPE_SECRET_KEY (platform, via Connect)'
        : 'per-client key or platform fallback',
      ghlWebhookUrl: config.ghlWebhookUrl,
    };
  }
  res.json(result);
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
