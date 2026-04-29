# south-hs-watcher

Watches the South Brunswick HS driver's ed page and pushes a notification when
new classes appear or existing ones become available.

- Page: https://ncdrivingschool.com/county/brunswick/south-brunswick-high-school/
- Schedule: every 30 min via GitHub Actions
- Notification: ntfy.sh push (free, no account required — just install the
  ntfy app and subscribe to your topic)
- State: `state.json` committed back to the repo

## Notification rules

You get one notification per change:

- **NEW** — a class slug we've never seen before
- **OPEN** — a previously sold-out class now has spots

If a class shows up brand new _and_ available, it fires once as NEW (not twice).
If a class goes available → sold out → available again, it re-fires.

## Setup

1. **Create a GitHub repo** and push this directory to it.

2. **Pick an ntfy topic.** Choose something hard to guess (anyone who knows
   the topic name can read your notifications). Example: `south-hs-watcher-9f3k2`.
   Install the ntfy app on your phone and subscribe to that topic.

3. **Add one repo secret** under Settings → Secrets and variables → Actions:
   - `NTFY_TOPIC` — your topic name, no leading slash, e.g. `south-hs-watcher-9f3k2`

4. **Enable Actions write permission**: Settings → Actions → General →
   Workflow permissions → "Read and write permissions". Required so the
   workflow can commit `state.json` back.

5. **Trigger a manual run** from the Actions tab to seed `state.json`. The
   first run will notify you about every currently-listed available class —
   that's expected. Subsequent runs only fire on changes.

## Local testing

```bash
npm install
NTFY_TOPIC=your-topic-name npm run check
```

To test the diff logic without sending notifications, comment out the
`await sendNtfy` calls in `src/check.ts` and just inspect the console output.

## Notes

- ntfy.sh is free and best-effort — no delivery guarantees. If you ever stop
  getting notifications, check the Actions logs and confirm the app is
  subscribed to the right topic.
- GitHub's free tier gives you 2,000 Action minutes/month. This job runs in
  ~15s, so 30-min cadence ≈ 12 min/day ≈ 360 min/month. Plenty of headroom.
- If the site ever changes its HTML structure, the cheerio selector
  (`h2 a[href*="/events/"]`) is the thing to update.
