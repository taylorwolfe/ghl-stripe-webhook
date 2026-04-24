const express = require('express');
const Stripe = require('stripe');

const app = express();
app.use(express.json());

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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

  // Create an invoice item
  await stripe.invoiceItems.create({
    customer: customer.id,
    amount: amountCents,
    currency: 'usd',
    description: `Investment — ${name || email}`,
  });

  // Create and finalize the invoice, which sends it to the customer
  const invoice = await stripe.invoices.create({
    customer: customer.id,
    collection_method: 'send_invoice',
    days_until_due: 30,
    auto_advance: true,
  });

  await stripe.invoices.sendInvoice(invoice.id);

  console.log(`Invoice ${invoice.id} sent to ${email} for $${(amountCents / 100).toFixed(2)}`);

  return res.status(200).json({ success: true, invoiceId: invoice.id });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
