# Runbook: Payment failures

## Elevated card_declined rate
A rising `card_declined` share is usually issuer-side and not actionable by us.
Confirm by grouping recent failures by `failure_code`. If `card_declined` is
above 60% of failures and the absolute volume is flat, take no action and note
it in the incident channel.

## gateway_timeout spike
`gateway_timeout` means our request to the payment provider exceeded the 10s
budget. Check `checkout_p95_latency_ms` for the same window. If latency is also
elevated, the provider is degraded: enable the retry queue and post to the
status page. Do not issue refunds for timeouts — the charge may still settle,
and refunding creates a double credit.

## insufficient_funds
Never retry automatically. Repeated attempts trigger issuer fraud heuristics and
can get the merchant account flagged. Wait for the customer to re-attempt.

## expired_card
Safe to prompt the customer to update their card. No ops action required.
