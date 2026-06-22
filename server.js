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

  if (event.type !== 'invoice.paid') {
    return res.status(200).json({ received: true });
  }

  const invoice = event.data.object;
  const customerId = invoice.customer;

  // Fetch the customer from Stripe to get their email
  const customer = await stripe.customers.retrieve(customerId);
  const email = customer.email;

  if (!email) {
    console.error(`No email on Stripe customer ${customerId}`);
    return res.status(200).json({ received: true });
  }

  console.log(`invoice.paid for ${email}, invoice ${invoice.id}`);

  // Look up the contact in GHL by email
  const searchRes = await fetch(
    `${GHL_BASE}/contacts/?query=${encodeURIComponent(email)}&locationId=${GHL_LOCATION_ID}`,
    {
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
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
      Authorization: `Bearer ${GHL_API_KEY}`,
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

app.post('/webhook', async (req, res) => {
  console.log('GHL webhook payload:', JSON.stringify(req.body, null, 2));

  const { email, name, investment_amount } = req.body;

  if (!email || !investment_amount) {
    return res.status(400).json({ error: 'Missing required fields: email, investment_amount' });
  }

  const amountCents = Math.round(parseFloat(String(investment_amount).replace(/[^0-9.]/g, '')) * 100);
  if (isNaN(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'investment_amount must be a positive number' });
  }

  // Find or create a Stripe customer by email
  const existingCustomers = await stripe.customers.list({ email, limit: 1 });
  let customer;
  if (existingCustomers.data.length > 0) {
    customer = existingCustomers.data[0];
  } else {
    customer = await stripe.customers.create({ email, name: name || undefined });
  }

  // Create the invoice first so the item can be explicitly attached to it
  const invoice = await stripe.invoices.create({
    customer: customer.id,
    collection_method: 'send_invoice',
    days_until_due: 30,
    auto_advance: true,
  });

  await stripe.invoiceItems.create({
    customer: customer.id,
    invoice: invoice.id,
    amount: amountCents,
    currency: 'usd',
    description: `Investment — ${name || email}`,
  });

  await stripe.invoices.sendInvoice(invoice.id);

  console.log(`Invoice ${invoice.id} sent to ${email} for $${(amountCents / 100).toFixed(2)}`);

  return res.status(200).json({ success: true, invoiceId: invoice.id });
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
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch contract template for clientId "${clientId}": ${res.status}`);
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

async function triggerGhlWorkflow({ email, name, documentId }) {
  if (triggeredDocuments.has(documentId)) {
    console.log(`GHL workflow already triggered for document ${documentId}, skipping`);
    return false;
  }
  triggeredDocuments.add(documentId);
  const webhookUrl = process.env.GHL_WORKFLOW_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('GHL_WORKFLOW_WEBHOOK_URL env var not set');
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

async function ghlAddTag(email, tag) {
  const searchRes = await fetch(
    `${GHL_BASE}/contacts/?query=${encodeURIComponent(email)}&locationId=${GHL_LOCATION_ID}`,
    { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' } }
  );
  if (!searchRes.ok) throw new Error(`GHL contact search failed: ${searchRes.status} ${await searchRes.text()}`);
  const { contacts } = await searchRes.json();
  const contact = contacts?.[0];
  if (!contact) throw new Error(`No GHL contact found for email: ${email}`);
  const updatedTags = Array.from(new Set([...(contact.tags || []), tag]));
  const updateRes = await fetch(`${GHL_BASE}/contacts/${contact.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
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

const SIGNWELL_TEMPLATES = {
  'cat-peters': 'ffee2537-dcc7-4432-b3f9-524ad6383c88',
};

app.post('/send-contract', async (req, res) => {
  const { clientId, clientName, clientEmail, investmentAmount, startDate, packageName, customTerms } = req.body;
  if (!clientId || !clientName || !clientEmail || !investmentAmount || !startDate) {
    return res.status(400).json({ error: 'Missing required fields: clientId, clientName, clientEmail, investmentAmount, startDate' });
  }

  const ccRecipients = process.env.COACH_EMAIL
    ? [{ email: process.env.COACH_EMAIL }]
    : [];

  const templateId = SIGNWELL_TEMPLATES[clientId];
  let signwellRes;

  if (templateId) {
    const payload = {
      name: `Coaching Agreement — ${clientName}`,
      signees: [{ id: '1', name: clientName, email: clientEmail }],
      ...(ccRecipients.length > 0 && { ccs: ccRecipients }),
      send_emails: true,
      callback_url: 'https://ghl-stripe-webhook-production.up.railway.app/signwell-webhook',
    };
    console.log(`Using SignWell template ${templateId} for clientId "${clientId}"`);
    console.log('SignWell template request body:', JSON.stringify(payload, null, 2));
    signwellRes = await fetch(`${SIGNWELL_BASE}/document_templates/${templateId}/documents`, {
      method: 'POST',
      headers: { 'X-Api-Key': process.env.SIGNWELL_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } else {
    let pdf;
    try {
      const html = await fetchContractTemplate(clientId, { clientName, startDate, investmentAmount, packageName, customTerms });
      pdf = await generateContractPDF(html);
    } catch (err) {
      console.error('PDF generation failed:', err.message);
      return res.status(500).json({ error: 'PDF generation failed', details: err.message });
    }
    const safeName = clientName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const payload = {
      name: `Coaching Agreement — ${clientName}`,
      files: [{ name: `coaching-contract-${safeName}.pdf`, file_base64: pdf.toString('base64') }],
      recipients: [{ id: '1', name: clientName, email: clientEmail }],
      ...(ccRecipients.length > 0 && { ccs: ccRecipients }),
      fields: [[
        { type: 'signature', recipient_id: '1', page: 2, x: 72, y: 500, width: 200, height: 50 },
      ]],
      send_emails: true,
      callback_url: 'https://ghl-stripe-webhook-production.up.railway.app/signwell-webhook',
    };
    console.log('SignWell request body:', JSON.stringify({ ...payload, files: '[omitted]' }, null, 2));
    signwellRes = await fetch(`${SIGNWELL_BASE}/documents/`, {
      method: 'POST',
      headers: { 'X-Api-Key': process.env.SIGNWELL_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  if (!signwellRes.ok) {
    const body = await signwellRes.text();
    console.error('SignWell API error:', signwellRes.status, body);
    return res.status(500).json({ error: 'Failed to send contract via SignWell', details: body });
  }

  const doc = await signwellRes.json();
  console.log(`Contract sent to ${clientEmail} via SignWell, document ID: ${doc.id}`);
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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/debug-env', (_req, res) => {
  const keys = ['GHL_WORKFLOW_WEBHOOK_URL', 'GHL_API_KEY', 'GHL_LOCATION_ID', 'SIGNWELL_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
  const result = {};
  for (const key of keys) {
    result[key] = process.env[key] ? 'set' : 'MISSING';
  }
  res.json(result);
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
