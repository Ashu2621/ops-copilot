# Runbook: Refunds

## When a refund is appropriate
Issue a refund only for `damaged_item`, `late_delivery` beyond the SLA, or a
confirmed `duplicate_charge`. Every refund requires a named approver; automated
refunds are not permitted under any circumstances.

## Duplicate charges
Confirm two succeeded payments exist for the same order before refunding.
Refund exactly one of them, at the full amount of that payment.

## Partial refunds
Partial refunds are allowed for late delivery. Cap them at 50% of the order
total unless a manager approves a larger amount.

## Never refund
Do not refund a `gateway_timeout` failure. Do not refund an order still in
`pending` status — no money has been captured yet.
