const express = require('express');
const Stripe = require('stripe');
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const app = express();

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE = 'https://services.leadconnectorhq.com';

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

// Ordered list of candidate Chrome paths per platform.
// Override with CHROME_PATH env var for non-standard installs.
const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/nix/var/nix/profiles/default/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ],
};

function getChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = CHROME_CANDIDATES[process.platform] || [];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const { execSync } = require('child_process');
    const found = execSync('which chromium || which google-chrome || which chromium-browser', { encoding: 'utf8' }).trim().split('\n')[0];
    if (found) return found;
  } catch {}
  throw new Error(
    'Chrome executable not found. Install Chrome or set the CHROME_PATH environment variable.'
  );
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildContractHTML({ clientName, investmentAmount, startDate, customTerms }) {
  const name = escapeHtml(clientName);
  const amount = escapeHtml(investmentAmount);
  const date = escapeHtml(startDate);
  const terms = customTerms ? escapeHtml(customTerms) : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif;
    font-size: 11pt;
    color: #1a1a1a;
    line-height: 1.6;
  }

  .logo {
    font-family: 'Arial Black', Arial, sans-serif;
    font-weight: 900;
    font-size: 36pt;
    color: #1414D4;
    line-height: 1.05;
    letter-spacing: -0.5px;
    margin-bottom: 44px;
  }

  h1 {
    font-size: 17pt;
    font-weight: 700;
    margin-bottom: 14px;
  }

  hr {
    border: none;
    border-top: 1px solid #d0d0d0;
    margin: 18px 0;
  }

  h2 {
    font-size: 11pt;
    font-weight: 700;
    margin-bottom: 8px;
  }

  p { margin-bottom: 8px; }

  ul {
    list-style: disc;
    padding-left: 22px;
  }

  ul li { margin-bottom: 4px; }

  .sig-label { font-weight: 700; }

  .sig-value {
    display: inline-block;
    min-width: 180px;
    border-bottom: 1.5px solid #1a1a1a;
    padding: 0 4px 1px;
    margin-left: 6px;
  }

  .sig-blank {
    display: inline-block;
    width: 240px;
    border-bottom: 1.5px solid #1a1a1a;
    margin-top: 28px;
  }

  .custom-terms-box {
    min-height: 72px;
    margin-top: 4px;
    padding-bottom: 4px;
    border-bottom: 1.5px solid #1a1a1a;
    white-space: pre-wrap;
    font-size: 10.5pt;
  }

  .coach-sig {
    font-family: 'Brush Script MT', 'Segoe Script', 'Lucida Handwriting', cursive;
    font-size: 26pt;
    line-height: 1;
    vertical-align: bottom;
  }
</style>
</head>
<body>

<div class="logo">KASH &amp;CO.<br>COACHING</div>

<h1>COACHING AGREEMENT</h1>

<p>This Coaching Agreement ("Agreement") is made between <strong>Kash &amp; Co. Coaching</strong> ("Coach"), and the undersigned client ("Client"). This Agreement sets forth the terms and conditions under which coaching services will be provided.</p>

<hr>

<h2>1. SERVICES PROVIDED</h2>
<p>Coach provides professional coaching services in the areas of life, performance, business, and relationship coaching. Coaching is a collaborative, client-driven process designed to facilitate personal and professional growth.</p>

<hr>

<h2>2. COACHING RELATIONSHIP</h2>
<p>The Coach's role is to support the Client in identifying and achieving goals. Coaching does <strong>not</strong> involve diagnosing or treating mental health conditions, and is not a substitute for therapy, legal, or financial advice.</p>

<hr>

<h2>3. PAYMENT &amp; REFUND POLICY</h2>
<ul>
  <li><strong>Payment is due in full prior to services commencing. All sales are final and non-refundable.</strong></li>
</ul>

<hr>

<h2>4. SCHEDULING &amp; CANCELLATIONS</h2>
<ul>
  <li>Sessions must be scheduled in advance and start on time.</li>
  <li>Client must provide <strong>at least 24 hours' notice</strong> to reschedule. Missed sessions without notice will be forfeited.</li>
  <li>Coach reserves the right to reschedule with reasonable notice if necessary.</li>
</ul>

<hr>

<h2>5. CONFIDENTIALITY</h2>
<ul>
  <li>All client information will remain strictly confidential.</li>
  <li>Exceptions include situations where disclosure is required by law (e.g., risk of harm to self/others, legal obligations).</li>
  <li>The Client may provide written permission for the Coach to share select insights when necessary or desired.</li>
</ul>

<hr>

<h2>6. CLIENT RESPONSIBILITIES</h2>
<ul>
  <li>The Client agrees to be open, honest, and committed to the coaching process.</li>
  <li>Coaching results depend on the Client's willingness to take action; no specific outcomes are guaranteed.</li>
  <li>If booking without an initial consultation, you confirm that you understand the scope of coaching services and agree to the terms outlined.</li>
</ul>

<hr>

<h2>7. INTERNATIONAL CLIENTS &amp; LEGAL COMPLIANCE</h2>
<ul>
  <li>Kash &amp; Co. Coaching serves clients globally. The Client acknowledges that coaching services are provided remotely and are governed by the laws of <strong>Ontario, Canada</strong>, and/or <strong>U.S. federal law</strong> as applicable.</li>
  <li>It is the Client's responsibility to ensure compliance with any local regulations regarding coaching services.</li>
</ul>

<hr>

<h2>8. TERMINATION</h2>
<p>Either party may terminate this Agreement with written notice. If terminated mid-package, unused sessions may be rescheduled but will not be refunded.</p>

<hr>

<h2>9. LIABILITY &amp; DISCLAIMER</h2>
<p>The Client agrees that the Coach shall not be liable for any direct, indirect, incidental, or consequential damages resulting from coaching services. Coaching is an exploratory process, and the Client assumes full responsibility for their decisions and actions.</p>

<hr>

<h2>10. AGREEMENT SIGNATURES</h2>
<p>By signing below, the Client acknowledges they have read, understood, and agreed to the terms of this Agreement.</p>

<div style="margin-top:16px;">

  <div style="margin-bottom:18px;">
    <span class="sig-label">Client Name:</span>
    <span class="sig-value">${name}</span>
  </div>

  <div style="display:flex;gap:48px;margin-bottom:18px;align-items:flex-end;">
    <div>
      <span class="sig-label">Investment Amount:</span>
      <span class="sig-value">${amount}</span>
    </div>
    <div>
      <span class="sig-label">Contract Start Date:</span>
      <span class="sig-value">${date}</span>
    </div>
  </div>

  <div style="margin-bottom:28px;">
    <div class="sig-label">Custom Terms (Special arrangements, if applicable. If not, leave blank):</div>
    <div class="custom-terms-box">${terms}</div>
  </div>

  <div style="margin-bottom:28px;">
    <div class="sig-label">Client Signature:</div>
    <div class="sig-blank"></div>
  </div>

  <div>
    <div class="sig-label">Coach Signature:</div>
    <div style="margin-top:6px;">
      <span class="coach-sig">Kash</span>
      <span style="display:inline-block;width:190px;border-bottom:1.5px solid #1a1a1a;vertical-align:bottom;margin-bottom:4px;"></span>
    </div>
  </div>

</div>
</body>
</html>`;
}

app.post('/generate-contract', async (req, res) => {
  const { clientName, investmentAmount, startDate, customTerms } = req.body;

  if (!clientName || !investmentAmount || !startDate) {
    return res.status(400).json({ error: 'Missing required fields: clientName, investmentAmount, startDate' });
  }

  const html = buildContractHTML({ clientName, investmentAmount, startDate, customTerms });

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: getChromePath(),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });

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

    const safeName = clientName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="coaching-contract-${safeName}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('PDF generation failed:', err.message);
    res.status(500).json({ error: 'PDF generation failed', details: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
