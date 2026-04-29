import * as cheerio from 'cheerio';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const PAGE_URL =
  'https://ncdrivingschool.com/county/brunswick/south-brunswick-high-school/';
const STATE_PATH = 'state.json';

interface ClassEvent {
  slug: string;
  title: string;
  url: string;
  status: string;
}

interface StoredEvent {
  status: string;
  firstSeen: string;
}

// Heuristic: does the status text look like registration is open?
// We don't know the exact wording the site will use, so cast a wide net.
function isLikelyOpen(status: string): boolean {
  return /\b(active|open|register|on\s*sale|available|sale)\b/i.test(status);
}

interface State {
  events: Record<string, StoredEvent>;
  lastChecked: string;
  consecutiveZero: number;
}

async function scrape(): Promise<ClassEvent[]> {
  const res = await fetch(PAGE_URL, {
    headers: { 'User-Agent': 'south-hs-watcher/1.0' }
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const events: ClassEvent[] = [];
  const seen = new Set<string>();

  $('a.ee-event-header-lnk').each((_, el) => {
    const $el = $(el);
    const url = ($el.attr('href') ?? '').trim();
    if (!url) return;

    const slugMatch = url.match(/\/events\/([^/]+)/);
    if (!slugMatch) return;
    const slug = slugMatch[1];
    if (seen.has(slug)) return;

    const status = $el.find('span.event-active-status').text().trim().replace(/\s+/g, ' ');
    // Title is the anchor text minus the status span text. Clone first so we
    // don't mutate the live DOM the iterator is walking.
    const $clone = $el.clone();
    $clone.find('span.event-active-status').remove();
    const title = $clone.text().trim().replace(/\s+/g, ' ');
    if (!title) return;

    seen.add(slug);
    events.push({ slug, title, url, status });
  });

  return events;
}

async function loadState(): Promise<State> {
  if (!existsSync(STATE_PATH)) {
    return { events: {}, lastChecked: '', consecutiveZero: 0 };
  }
  const raw = await readFile(STATE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as Partial<State>;
  return {
    events: parsed.events ?? {},
    lastChecked: parsed.lastChecked ?? '',
    consecutiveZero: parsed.consecutiveZero ?? 0
  };
}

async function saveState(state: State): Promise<void> {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

interface Notification {
  reason: 'new' | 'changed';
  event: ClassEvent;
  prevStatus?: string;
}

function diff(current: ClassEvent[], state: State): Notification[] {
  const notifications: Notification[] = [];
  const nowIso = new Date().toISOString();

  for (const ev of current) {
    const prev = state.events[ev.slug];

    if (!prev) {
      notifications.push({ reason: 'new', event: ev });
      state.events[ev.slug] = { status: ev.status, firstSeen: nowIso };
      continue;
    }

    if (ev.status !== prev.status) {
      notifications.push({ reason: 'changed', event: ev, prevStatus: prev.status });
      prev.status = ev.status;
    }
  }

  return notifications;
}

async function sendNtfy(
  body: string,
  title: string,
  priority: 'default' | 'high' | 'urgent' = 'default',
  tags = 'car'
): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) throw new Error('Missing NTFY_TOPIC');

  const res = await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: title,
      Tags: tags,
      Priority: priority,
      Click: PAGE_URL
    },
    body
  });

  if (!res.ok) {
    throw new Error(`ntfy failed: ${res.status} ${await res.text()}`);
  }
}

function tagFor(n: Notification): string {
  if (n.reason === 'new') return 'NEW';
  return isLikelyOpen(n.event.status) ? 'OPEN' : 'CHANGED';
}

function formatNotifications(notifications: Notification[]): string {
  const lines = notifications.map((n) => {
    const tag = tagFor(n);
    const status = n.event.status || '(no status)';
    const transition =
      n.reason === 'changed' && n.prevStatus !== undefined
        ? `${n.prevStatus || '(none)'} → ${status}`
        : status;
    return `[${tag}] ${transition}: ${n.event.title}\n${n.event.url}`;
  });
  return ['South HS:', ...lines].join('\n\n');
}

async function main(): Promise<void> {
  const current = await scrape();
  console.log(`Scraped ${current.length} classes`);

  const state = await loadState();

  if (current.length === 0) {
    state.consecutiveZero += 1;
    console.log(`Zero-class run (streak: ${state.consecutiveZero})`);

    if (state.consecutiveZero >= 2) {
      await sendNtfy(
        `Scraper has returned 0 classes for ${state.consecutiveZero} runs in a row. The site markup may have changed, or the page is broken. Investigate ASAP:\n\n${PAGE_URL}`,
        `South HS: ${state.consecutiveZero} ZERO-CLASS RUNS`,
        'urgent',
        'rotating_light'
      );
    }

    state.lastChecked = new Date().toISOString();
    await saveState(state);
    return;
  }

  // Found classes — reset the zero-run counter.
  state.consecutiveZero = 0;

  const notifications = diff(current, state);

  if (notifications.length > 0) {
    console.log(`Sending ${notifications.length} notification(s)`);
    const body = formatNotifications(notifications);
    const subject = `South HS: ${notifications.length} update${notifications.length === 1 ? '' : 's'}`;
    console.log(body);
    // If any notification looks like registration just opened, bump priority
    // so the phone makes the loud noise.
    const opened = notifications.some(
      (n) => n.reason === 'changed' && isLikelyOpen(n.event.status)
    );
    await sendNtfy(body, subject, opened ? 'high' : 'default');
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
