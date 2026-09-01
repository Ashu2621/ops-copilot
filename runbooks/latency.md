# Runbook: Checkout latency

## checkout_p95_latency_ms above 500ms
First check whether the increase is broad or confined to one dependency.
Pull `orders_per_minute` for the same window: if throughput rose proportionally,
this is load and the autoscaler should catch up within ten minutes.

If throughput is flat while latency climbed, suspect the database. The usual
cause is lock contention on the orders table during a long-running report query.
Identify and cancel the offending query before scaling — adding replicas does
not clear a lock.

## Sustained latency with flat throughput
Escalate to the platform on-call after 15 minutes. Do not restart the checkout
service during an active incident; in-flight payment intents are lost on restart
and reconciling them is manual.
