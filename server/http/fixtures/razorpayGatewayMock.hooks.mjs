/**
 * TEST-MODE Razorpay gateway hooks + in-memory gateway (one module on purpose).
 *
 * Registered by razorpayGatewayMock.cjs via `module.register()`. The `resolve`
 * hook rewrites the bare specifier `razorpay` to THIS module's URL, so
 * `import Razorpay from 'razorpay'` in production code receives the default
 * export below — an in-memory gateway that never touches the network. Because
 * the module is its own resolve target, hooks and gateway state share one
 * instance with no extra wiring.
 *
 * Fake gateway contract (mirrors only what production calls):
 *   - orders.create(params) stores the order exactly as sent (amount, currency,
 *     receipt, notes) and returns it with a generated `order_e2e_<n>` id — the
 *     payer notes under test therefore come from production's createRazorpayOrder;
 *   - orders.fetch(id) returns the stored order, else a 404-shaped error;
 *   - payments.fetch('pay::<orderId>::<status>') synthesises a payment for a
 *     stored order: same order_id/amount/currency/notes, requested status;
 *     any other id gets a 404-shaped error.
 *
 * TEST MODE ONLY — never loaded by production code.
 */

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'razorpay') {
    return { url: import.meta.url, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}

const orders = new Map();
let seq = 0;

const PAYMENT_ID_RE = /^pay::(order_e2e_\d+)::(created|authorized|captured|refunded|failed)$/;

function notFound(what) {
  const err = new Error(`${what} does not exist`);
  err.statusCode = 404;
  return err;
}

export default class FakeRazorpay {
  constructor(options) {
    // The key material still comes from the environment; nothing here dials out.
    this.options = options;

    this.orders = {
      create: async (params) => {
        seq += 1;
        const order = {
          id: `order_e2e_${seq}`,
          entity: 'order',
          amount: params.amount,
          currency: params.currency,
          receipt: params.receipt,
          notes: params.notes || {},
          status: 'created',
          attempts: 0,
          amount_paid: 0,
          amount_due: params.amount,
          created_at: Math.floor(Date.now() / 1000),
        };
        orders.set(order.id, order);
        return order;
      },
      fetch: async (orderId) => {
        const order = orders.get(String(orderId));
        if (!order) throw notFound('Order');
        return order;
      },
    };

    this.payments = {
      fetch: async (paymentId) => {
        const match = PAYMENT_ID_RE.exec(String(paymentId));
        if (!match) throw notFound('Payment');
        const order = orders.get(match[1]);
        if (!order) throw notFound('Order');
        const status = match[2];
        return {
          id: String(paymentId),
          entity: 'payment',
          order_id: order.id,
          amount: order.amount,
          currency: order.currency,
          status,
          captured: status === 'captured',
          notes: order.notes,
          created_at: order.created_at,
        };
      },
    };
  }
}
