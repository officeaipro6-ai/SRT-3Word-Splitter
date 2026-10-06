/**
 * TEST-MODE Razorpay gateway stand-in for HTTP-level purchase tests.
 *
 * Razorpay is imported from production code as an ES module, and Node's ESM
 * loader does NOT consult `require.cache` (nor `Module._load`), so a CommonJS
 * cache patch is silently ignored. The supported seam is `module.register()`,
 * which installs resolve/load hooks for the whole child process.
 *
 * This file is the preload (`node --require razorpayGatewayMock.cjs`). It
 * registers `razorpayGatewayMock.hooks.mjs`, which:
 *   - resolves the bare specifier `razorpay` to ITSELF, so production code
 *     gets the in-memory gateway below instead of the real SDK;
 *   - exports that gateway as its default export.
 *
 * State model (deliberately minimal):
 *   - orders.create() stores the order (amount + notes) exactly as the
 *     production route sent it, so the payer notes under test are written by
 *     production code, not by this fixture;
 *   - orders.fetch() returns that stored order or throws a 404-shaped error;
 *   - payments.fetch('pay::<orderId>::<status>') synthesises a payment for a
 *     stored order (same order_id/amount/currency/notes, requested status);
 *     any other id throws a 404-shaped error.
 *
 * Nothing here dials out; no request ever leaves this machine.
 *
 * TEST MODE ONLY — never loaded by production code.
 */
'use strict';

const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

register('./razorpayGatewayMock.hooks.mjs', pathToFileURL(__filename));
