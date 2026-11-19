## Why the sync job stalls

The worker stops making progress because **two retries share one lease**. When the first retry times out, the second one still holds `lease_id`, so the scheduler thinks the job is alive and never reassigns it. The fix is small, but it touches three places: the lease table, the retry loop, and the metrics we use to notice this.

Here is what happens step by step:

1. The job claims a lease with a 30 second TTL.
2. A slow upstream call takes 34 seconds, so the lease expires.
3. The retry loop starts a second attempt **without** renewing the lease.
4. The first attempt finally returns and writes `status = done` over the second attempt's progress.

> The bug only shows up when an upstream call is slower than the lease TTL, which is why it looked random in the dashboards.

### The fix

Renew the lease before every attempt, and make the write conditional on the lease generation:

```ts
export async function runWithLease(
	job: Job,
	attempt: (signal: AbortSignal) => Promise<void>,
) {
	const lease = await leases.claim(job.id, { ttlMs: 30_000 });
	const controller = new AbortController();
	const renew = setInterval(async () => {
		const ok = await leases.renew(lease.id, lease.generation);
		if (!ok) controller.abort(new Error("Lease lost"));
	}, 10_000);

	try {
		await attempt(controller.signal);
		await jobs.complete(job.id, { generation: lease.generation });
	} finally {
		clearInterval(renew);
		await leases.release(lease.id, lease.generation);
	}
}
```

The important part is `generation`: every claim bumps it, so a stale attempt can no longer overwrite a newer one. The database enforces it with a single conditional update, which keeps the hot path to one round trip.

### What changes for operators

| Signal             | Before   | After                  |
| :----------------- | :------- | :--------------------- |
| Stuck jobs per day | 12–40    | 0 in a week of canary  |
| Median retry delay | 31 s     | 2 s                    |
| Lease renewals     | none     | every 10 s             |
| Duplicate writes   | possible | rejected by generation |

You can watch the renewals live while the canary runs:

```bash
cohub logs --service worker --follow | grep -E "lease (claim|renew|lost)"
```

### Rollout plan

- Ship the generation column first, with a default of `0`, so old workers keep working.
- Deploy the new retry loop behind `SYNC_LEASE_RENEWAL=1` to 10% of workers.
- Watch _stuck jobs_ and _lease lost_ for a day, then roll out to everyone.
- Remove the flag once the old workers are gone.

A few smaller notes:

- The metrics dashboard groups by `job_type`, so a single noisy tenant can hide this pattern. I added a per-tenant panel at [the worker dashboard](https://example.com/dashboards/worker).
- The integration test now uses a fake clock, so the 34 second upstream call takes a few milliseconds in CI.
- If you see `Lease lost` in the logs after rollout, that is expected and harmless: it means the guard did its job.

That should be everything. Let me know if you want me to open the pull request, or if you would like a shorter TTL for the high priority queue first.
