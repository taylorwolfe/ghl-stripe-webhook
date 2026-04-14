# GHL Stripe Webhook

Receives a GoHighLevel webhook and creates a Stripe invoice for the contact.

## Expected Payload

POST `/webhook` with JSON body:

```json
{
  "email": "contact@example.com",
  "name": "Jane Doe",
  "investment_amount": "2500.00"
}
```

`investment_amount` is treated as USD (e.g. `"2500.00"` → $2,500.00).

## Local Development

```bash
npm install
STRIPE_SECRET_KEY=sk_test_... npm run dev
```

Test with curl:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","name":"Test User","investment_amount":"1000"}'
```

## Deploy to Render

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) and click **New → Web Service**.
3. Connect your GitHub repo.
4. Configure the service:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Under **Environment Variables**, add:
   - `STRIPE_SECRET_KEY` → your Stripe secret key (`sk_live_...` for production)
6. Click **Deploy**.

Render will provide a public URL like `https://your-service.onrender.com`. Use that URL as the webhook endpoint in GoHighLevel:

**GoHighLevel Setup**

1. In GHL, go to **Automation → Workflows** (or **Triggers**).
2. Add a **Webhook** action.
3. Set the URL to `https://your-service.onrender.com/webhook`.
4. Map the fields:
   - `email` → Contact Email
   - `name` → Contact Full Name
   - `investment_amount` → your custom field value

## Notes

- The server looks up existing Stripe customers by email before creating a new one, avoiding duplicates.
- Invoices are sent immediately via Stripe's email delivery with a 30-day due date.
- Use `sk_test_...` keys during development; switch to `sk_live_...` in production.
