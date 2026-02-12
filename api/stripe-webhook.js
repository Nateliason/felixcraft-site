import Stripe from 'stripe';
import { Resend } from 'resend';
import { buffer } from 'micro';

// Support both org keys (with Stripe-Context) and regular keys
const stripeConfig = {};
if (process.env.STRIPE_ACCOUNT_CONTEXT) {
  stripeConfig.stripeAccount = process.env.STRIPE_ACCOUNT_CONTEXT;
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, stripeConfig);
const resend = new Resend(process.env.RESEND_API_KEY);

// Disable Vercel's default body parsing — Stripe needs the raw body for signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // Handle checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Log all checkout sessions for debugging
    console.log('Checkout session:', session.id, 'amount:', session.amount_total, 'email:', session.customer_details?.email || session.customer_email);

    // Only process felixcraft.ai purchases ($29 = 2900 cents)
    // Also accept amounts close to 2900 in case of rounding/tax
    if (session.amount_total < 2800 || session.amount_total > 3100) {
      console.log('Skipping non-felixcraft purchase:', session.id, 'amount:', session.amount_total);
      return res.status(200).json({ received: true, skipped: true });
    }

    const customerEmail = session.customer_details?.email || session.customer_email;

    if (!customerEmail) {
      console.error('No customer email found for session:', session.id);
      return res.status(400).json({ error: 'No customer email' });
    }

    try {
      // Send download email via Resend
      await resend.emails.send({
        from: 'Felix Craft <felix@masinov.co>',
        to: customerEmail,
        subject: 'Your "How to Hire an AI" download is ready',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { text-align: center; margin-bottom: 30px; }
              .header h1 { font-size: 24px; color: #c4a35a; margin: 0; }
              .content { background: #f9f9f9; border-radius: 8px; padding: 30px; margin-bottom: 20px; }
              .download-btn { display: inline-block; background: #c4a35a; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; }
              .footer { text-align: center; font-size: 14px; color: #666; }
              .footer a { color: #c4a35a; text-decoration: none; }
            </style>
          </head>
          <body>
            <div class="header">
              <h1>You're in</h1>
            </div>
            <div class="content">
              <p>Thanks for grabbing <strong>How to Hire an AI</strong>.</p>
              <p>Click below to download your copy:</p>
              <p style="text-align: center;">
                <a href="https://felixcraft.ai/dl/c5768e3409026bab01bb1649.pdf" class="download-btn">Download PDF</a>
              </p>
              <p>You can also access your thank-you page anytime at:<br>
              <a href="https://felixcraft.ai/168a1eb2dd92fd596ac191d4">https://felixcraft.ai/168a1eb2dd92fd596ac191d4</a></p>
            </div>
            <div class="footer">
              <p>Questions? <a href="https://x.com/FelixCraftAI">@FelixCraftAI</a> · <a href="mailto:felix@masinov.co">felix@masinov.co</a></p>
            </div>
          </body>
          </html>
        `,
      });

      console.log('Download email sent to:', customerEmail);
      return res.status(200).json({ received: true, emailSent: true });

    } catch (error) {
      console.error('Failed to send email:', error);
      return res.status(500).json({ error: 'Failed to send email', details: error.message });
    }
  }

  // Return 200 for other event types
  return res.status(200).json({ received: true });
}
