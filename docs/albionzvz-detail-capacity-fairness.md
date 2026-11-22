# Shared AlbionZvZ Detail capacity: safe waiting and round-robin fairness

Base: cef2a53163599ada8d0b8ea0b7aab7013d696ff5 (PR #52). No production changes until explicit approval.

The primary AlbionZvZ Detail client already enforces **three fresh Details
per minute** shared across all tracked Guilds and Discord servers. When the
budget was exhausted, the selector previously used Official immediately.

This change (1) rotates the first Discord server every 60-second scan and
tracked Guild order within each server, (2) on **DETAIL_REQUEST_BUDGET only**
keeps the Battle ID in the existing in-process pending queue, waits at most
**120 seconds**, and retries in the next scheduled poll (with a 45s admission
pause), (3) uses Official if the two-minute cap expires or if AlbionZvZ has an
actual error, denied access, invalid detail, 404 or cooldown.

The waiting key is Discord server + tracked Guild + Battle ID. Capacity-only
waits do **not** mark IDs handled, mutate tracking or Supabase, schedule
Official 404 backoff, or create duplicate reports. Process restart clears
only the temporary wait clock.

Invariants: shared cap **3 Details / 60s**, min shared HTTP gap **3.5s**,
the 25-row List and 60s List cache, 60s scan, global 403/429 circuit,
tracking filters, existing report URLs, layout, CTA/AVA/Bandit are all
unchanged. No API calls are made by the new scheduling helper.

Risks: an individual report may be delayed about two minutes plus normal
poll/send time; using otherwise free later Detail slots can raise total
provider traffic over time versus immediate Official, even though the peak
rate cannot increase. The third-party provider may still return 403/429.

Acceptance: run full CI, inspect source/retry logs after a controlled
one-restart deploy and a verified Tracking backup. Do not merge or deploy
until separately approved.
