import * as cheerio from 'cheerio';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const PAGE_URL =
  'https://ncdrivingschool.com/county/brunswick/north-brunswick-high-school/';
const STATE_PATH = 'state.json';

interface ClassEvent {
  slug: string;
  title: string;
  url: string;
  soldOut: boolean;
}

interface StoredEvent {
  soldOut: boolean;
  notifiedAvailable: boolean;
  firstSeen: string;
}

interface State {
  events: Record<string, StoredEvent>;
  lastChecked: string;
}

async function scrape(): Promise<ClassEvent[]> {
  const res = await fetch(PAGE_URL, {
    headers: { 'User-Agent': 'ncds-watcher/1.0' }
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const events: ClassEvent[] = [];
  const seen = new Set<string>();

  $('h2 a[href*="/events/"]').each((_, el) => {
    const $el = $(el);
    const url = ($el.attr('href') ?? '').trim();
    const rawTitle = $el.text().trim().replace(/\s+/g, ' ');
    if (!url || !rawTitle) return;

    const slugMatch = url.match(/\/events\/([^/]+)/);
    if (!slugMatch) return;
    const slug = slugMatch[1];
    if (seen.has(slug)) return;
    seen.add(slug);

    const soldOut = /^sold out\b/i.test(rawTitle);
    const title = rawTitle.replace(/^sold out\s*/i, '').trim();

    events.push({ slug, title, url, soldOut });
  });

  return events;
}

async function loadState(): Promise<State> {
  if (!existsSync(STATE_PATH)) {
    return { events: {}, lastChecked: '' };
  }
  const raw = await readFile(STATE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as Partial<State>;
  return {
    events: parsed.events ?? {},
    lastChecked: parsed.lastChecked ?? ''
  };
}

async function saveState(state: State): Promise<void> {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

interface Notification {
  reason: 'new' | 'available';
  event: ClassEvent;
}

function diff(current: ClassEvent[], state: State): Notification[] {
  const notifications: Notification[] = [];
  const nowIso = new Date().toISOString();

  for (const ev of current) {
    const prev = state.events[ev.slug];

    if (!prev) {
      // Brand new class
      notifications.push({ reason: 'new', event: ev });
      state.events[ev.slug] = {
        soldOut: ev.soldOut,
        // If it appears already available, the "new" alert covers it —
        // mark as already-notified so we don't double-fire next run.
        notifiedAvailable: !ev.soldOut,
        firstSeen: nowIso
      };
      continue;
    }

    // Existing class — did it open up?
    if (!ev.soldOut && !prev.notifiedAvailable) {
      notifications.push({ reason: 'available', event: ev });
      prev.notifiedAvailable = true;
    }

    // If it went back to sold out, reset so a future re-opening re-fires.
    if (ev.soldOut && prev.notifiedAvailable) {
      prev.notifiedAvailable = false;
    }

    prev.soldOut = ev.soldOut;
  }

  return notifications;
}

async function sendNtfy(body: string, title: string): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) throw new Error('Missing NTFY_TOPIC');

  const res = await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: title,
      Tags: 'car',
      Click: 'https://ncdrivingschool.com/county/brunswick/north-brunswick-high-school/'
    },
    body
  });

  if (!res.ok) {
    throw new Error(`ntfy failed: ${res.status} ${await res.text()}`);
  }
}

async function sendEmail(body: string, subject: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const to = process.env.NOTIFY_EMAIL;

  if (!apiKey || !from || !to) {
    throw new Error('Missing RESEND_API_KEY, RESEND_FROM, or NOTIFY_EMAIL');
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to, subject, text: body })
  });

  if (!res.ok) {
    throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
  }
}

function formatNotifications(notifications: Notification[]): string {
  const lines = notifications.map((n) => {
    const tag = n.reason === 'new' ? 'NEW' : 'OPEN';
    return `[${tag}] ${n.event.title}\n${n.event.url}`;
  });
  return ['NCDS North Brunswick:', ...lines].join('\n\n');
}

async function main(): Promise<void> {
  const current = await scrape();
  console.log(`Scraped ${current.length} classes`);

  const state = await loadState();
  const notifications = diff(current, state);

  if (notifications.length > 0) {
    console.log(`Sending ${notifications.length} notification(s)`);
    const body = formatNotifications(notifications);
    const subject = `NCDS: ${notifications.length} update${notifications.length === 1 ? '' : 's'}`;
    console.log(body);

    // Send both in parallel; if one fails, still try the other.
    const results = await Promise.allSettled([
      sendNtfy(body, subject),
      sendEmail(body, subject)
    ]);
    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      for (const f of failures) {
        console.error('Notification channel failed:', (f as PromiseRejectedResult).reason);
      }
      // Only hard-fail if BOTH channels failed.
      if (failures.length === results.length) {
        throw new Error('All notification channels failed');
      }
    }
  } else {
    console.log('No changes');
  }

  state.lastChecked = new Date().toISOString();
  await saveState(state);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
