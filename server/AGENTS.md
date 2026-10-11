# StealthLynk Server — Project Guide

## Test Commands

- **Focused regression suite**: `node --test server/paymentRecovery.test.js` (run from repo root)
- **Name-pattern subset**: `node --test --test-name-pattern='admin|subscriptionSchema|subscriptionReadiness|verifyPsPaymentTx' server/paymentRecovery.test.js`
- **Syntax check**: `node --check server/server.js` (repeat for each edited file)

## Testing notes

- Tests use temporary databases and mocked RPC/fixtures — no live server, no production data.
- Do not `require('server.js')` directly as a test: it opens the configured database and schedules background work, although listener startup is guarded. Production code is exercised by extracting marked regions/functions into a VM sandbox instead.
