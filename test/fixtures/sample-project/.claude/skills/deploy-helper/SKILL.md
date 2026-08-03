---
name: deploy-helper
description: Guides a production deploy, including migration checks and rollback steps.
---

# Deploy helper

This body is long on purpose so the budget report can demonstrate the difference
between what is advertised in context and what is actually loaded on invocation.

## Steps

1. Verify the migration plan against the staging database.
2. Confirm the rollback script exists and has been run in staging this week.
3. Announce the deploy window in the release channel.
4. Run the smoke suite against the canary instance.
5. Watch error rates for fifteen minutes before widening the rollout.

## Rollback

If error rates exceed the agreed threshold, run the rollback script immediately
and only then start diagnosing. Do not attempt a forward fix during an incident
window unless the on-call lead explicitly approves it.
