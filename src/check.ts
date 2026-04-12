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
  return JSON.parse(raw) as State;
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

async function sendSms(body: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const phone = process.env.PHONE_NUMBER; // digits only, e.g. "9105551234"

  if (!apiKey || !from || !phone) {
    throw new Error('Missing RESEND_API_KEY, RESEND_FROM, or PHONE_NUMBER');
  }

  const to = `${phone}@tmomail.net`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to,
      subject: 'NBHS Drivers Ed Check Update',
      text: body
    })
  });

  if (!res.ok) {
    throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
  }
}

function formatNotifications(notifications: Notification[]): string {
  // SMS gateways truncate long messages, so keep this tight.
  const lines = notifications.map((n) => {
    const tag = n.reason === 'new' ? 'NEW' : 'OPEN';
    return `[${tag}] ${n.event.title}`;
  });
  return ['NCDS North Brunswick:', ...lines].join('\n');
}

async function main(): Promise<void> {
  const current = await scrape();
  console.log(`Scraped ${current.length} classes`);

  const state = await loadState();
  const notifications = diff(current, state);

  if (notifications.length > 0) {
    console.log(`Sending ${notifications.length} notification(s)`);
    const body = formatNotifications(notifications);
    console.log(body);
    await sendSms(body);
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
