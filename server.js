const express = require('express');
const Stripe = require('stripe');

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
    `${GHL_BASE}/contacts/?email=${encodeURIComponent(email)}&locationId=${GHL_LOCATION_ID}`,
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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
