# ncds-watcher

Watches the North Brunswick HS driver's ed page and texts you when new classes
appear or existing ones become available.

- Page: https://ncdrivingschool.com/county/brunswick/north-brunswick-high-school/
- Schedule: every 30 min via GitHub Actions
- Notification: Resend → T-Mobile email-to-SMS gateway (`<number>@tmomail.net`)
- State: `state.json` committed back to the repo

## Notification rules

You get one text per change:

- **NEW** — a class slug we've never seen before
- **OPEN** — a previously sold-out class now has spots

If a class shows up brand new _and_ available, it fires once as NEW (not twice).
If a class goes available → sold out → available again, it re-fires.

## Setup

1. **Create a GitHub repo** and push this directory to it.

2. **Verify a domain on Resend** (https://resend.com). Email-to-SMS gateways
   reject mail from unverified senders, so `onboarding@resend.dev` won't work
   here — you need a domain you own. Use one of yours; takes ~5 min to add the
   DNS records.

3. **Add three repo secrets** under Settings → Secrets and variables → Actions:
   - `RESEND_API_KEY` — from the Resend dashboard
   - `RESEND_FROM` — e.g. `alerts@yourdomain.com`
   - `PHONE_NUMBER` — your T-Mobile number, digits only, e.g. `9105551234`

4. **Enable Actions write permission**: Settings → Actions → General →
   Workflow permissions → "Read and write permissions". Required so the
   workflow can commit `state.json` back.

5. **Trigger a manual run** from the Actions tab to seed `state.json`. The
   first run will text you about every currently-listed available class —
   that's expected. Subsequent runs only fire on changes.

## Local testing

```bash
npm install
RESEND_API_KEY=... RESEND_FROM=alerts@yourdomain.com PHONE_NUMBER=9105551234 \
  npm run check
```

To test the diff logic without sending texts, comment out the `await sendSms`
line in `src/check.ts` and just inspect the console output.

## Notes

- T-Mobile's `tmomail.net` gateway is free but best-effort — no delivery
  guarantees. If you ever stop getting texts, check the Actions logs and your
  phone's spam/unknown-sender filtering.
- GitHub's free tier gives you 2,000 Action minutes/month. This job runs in
  ~15s, so 30-min cadence ≈ 12 min/day ≈ 360 min/month. Plenty of headroom.
- If the site ever changes its HTML structure, the cheerio selector
  (`h2 a[href*="/events/"]`) is the thing to update.
