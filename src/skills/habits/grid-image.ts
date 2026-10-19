// ============================================================================
// 🎨 The pastel habit grid as a PNG — because WhatsApp draws 🟩/🟥 emoji with
// its own glossy gradients, and we wanted something flat, soft and calm.
// SVG (hand-built below) → PNG via resvg, with Inter shipped in assets/fonts/
// (the slim Docker image has no fonts of its own).
//
// The look, in one place — tweak these and every grid follows:
//   done = pastel mint · skipped = soft coral · no entry = light grey,
//   flat rounded squares, no ✓/✕ marks, today's column gets a faint dashed ring.
// ============================================================================

import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';
import { addDays } from '../../clock.ts';

type Status = 'done' | 'skipped';
export interface GridHabit { name: string; byDate: Map<string, Status> }

const FONT_DIR = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));
const FONT_FILES = ['Inter-400.ttf', 'Inter-600.ttf', 'Inter-700.ttf'].map((f) => FONT_DIR + f);

const C = {
  bg: '#FBFAF7', card: '#FFFFFF', ink: '#2F3A40', sub: '#8C969C', line: '#EEF0F1', brand: '#5FA585',
  done: '#BFE6D3',     // 🌿 pastel mint
  skipped: '#F8CFC8',  // 🍑 soft coral
  none: '#F1F2F4',     // ☁️ light grey
  todayRing: '#C9D3D8',
} as const;

const W = 1080, PAD = 64, CELL = 74, GAP = 12, NAME_W = 352;
const MAX_NAME_CHARS = 17;
const MAX_ROWS = 12; // 🧯 keeps the picture phone-sized

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clipName = (s: string) => (s.length > MAX_NAME_CHARS ? s.slice(0, MAX_NAME_CHARS - 1).trimEnd() + '…' : s);
// 📅 en-GB says "Sept" — everything else is three letters, so match it
const fmt = (d: string, opts: Intl.DateTimeFormatOptions) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' }).replace('Sept', 'Sep');

// 🖼️ 7 days ending `today`, one row per habit.
export const renderWeekGridPng = (habits: GridHabit[], today: string, title = 'Your week in habits'): Buffer => {
  const rows = habits.slice(0, MAX_ROWS);
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const gridX = W - PAD - (7 * CELL + 6 * GAP);
  const headY = 228, rowY0 = headY + 76, rowH = CELL + GAP;
  const H = rowY0 + rows.length * rowH + (habits.length > MAX_ROWS ? 50 : 0) + 160;

  let done = 0, skipped = 0;
  const parts: string[] = [];

  // 🗓️ day letters + dates; today's in darker ink
  days.forEach((d, i) => {
    const cx = gridX + i * (CELL + GAP) + CELL / 2;
    parts.push(`<text x="${cx}" y="${headY}" text-anchor="middle" font-size="30" font-weight="600" fill="${d === today ? C.ink : C.sub}">${fmt(d, { weekday: 'short' }).slice(0, 1)}</text>`);
    parts.push(`<text x="${cx}" y="${headY + 38}" text-anchor="middle" font-size="26" fill="${C.sub}">${fmt(d, { day: 'numeric' })}</text>`);
  });

  // 🟩 the squares — flat, no marks
  rows.forEach((h, r) => {
    const y = rowY0 + r * rowH;
    parts.push(`<text x="${PAD}" y="${y + CELL / 2 + 12}" font-size="34" font-weight="600" fill="${C.ink}">${esc(clipName(h.name))}</text>`);
    days.forEach((d, i) => {
      const x = gridX + i * (CELL + GAP);
      const s = h.byDate.get(d);
      if (s === 'done') done++; else if (s === 'skipped') skipped++;
      parts.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="20" fill="${s ? C[s] : C.none}"/>`);
      if (d === today) parts.push(`<rect x="${x - 4}" y="${y - 4}" width="${CELL + 8}" height="${CELL + 8}" rx="23" fill="none" stroke="${C.todayRing}" stroke-width="2.5" stroke-dasharray="6 6"/>`);
    });
  });
  if (habits.length > MAX_ROWS) {
    parts.push(`<text x="${PAD}" y="${rowY0 + rows.length * rowH + 30}" font-size="28" fill="${C.sub}">…plus ${habits.length - MAX_ROWS} more</text>`);
  }

  // 🏷️ legend
  const ly = H - 76;
  const legend = (x: number, fill: string, label: string) =>
    `<rect x="${x}" y="${ly - 28}" width="38" height="38" rx="11" fill="${fill}"/><text x="${x + 54}" y="${ly + 2}" font-size="30" fill="${C.sub}">${label}</text>`;

  const range = `${fmt(days[0], { weekday: 'short', day: 'numeric' })} – ${fmt(today, { weekday: 'short', day: 'numeric', month: 'short' })}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="40" fill="${C.card}"/>
<text x="${PAD}" y="118" font-size="52" font-weight="700" fill="${C.ink}">${esc(title)}</text>
<text x="${PAD}" y="166" font-size="30" fill="${C.sub}">${range}  ·  ${done} done  ·  ${skipped} skipped</text>
<text x="${W - PAD}" y="118" text-anchor="end" font-size="30" font-weight="600" fill="${C.brand}">pekzho</text>
${parts.join('\n')}
<line x1="${PAD}" y1="${ly - 62}" x2="${W - PAD}" y2="${ly - 62}" stroke="${C.line}" stroke-width="2"/>
${legend(PAD, C.done, 'Done')}${legend(PAD + 190, C.skipped, 'Skipped')}${legend(PAD + 420, C.none, 'No entry')}
</svg>`;

  return new Resvg(svg, {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' },
    fitTo: { mode: 'width', value: W },
  }).render().asPng();
};

// --------------------------------------------------------------------------
// 🧱 Shared bits for the stats pictures below
// --------------------------------------------------------------------------
const toPng = (svg: string): Buffer =>
  new Resvg(svg, {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' },
    fitTo: { mode: 'width', value: W },
  }).render().asPng();

const card = (H: number, title: string, subtitle: string, inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="40" fill="${C.card}"/>
<text x="${PAD}" y="118" font-size="52" font-weight="700" fill="${C.ink}">${esc(title)}</text>
<text x="${PAD}" y="166" font-size="30" fill="${C.sub}">${esc(subtitle)}</text>
<text x="${W - PAD}" y="118" text-anchor="end" font-size="30" font-weight="600" fill="${C.brand}">pekzho</text>
${inner}
</svg>`;

const legendRow = (ly: number) => {
  const item = (x: number, fill: string, label: string) =>
    `<rect x="${x}" y="${ly - 28}" width="38" height="38" rx="11" fill="${fill}"/><text x="${x + 54}" y="${ly + 2}" font-size="30" fill="${C.sub}">${label}</text>`;
  return `<line x1="${PAD}" y1="${ly - 62}" x2="${W - PAD}" y2="${ly - 62}" stroke="${C.line}" stroke-width="2"/>`
    + item(PAD, C.done, 'Done') + item(PAD + 190, C.skipped, 'Skipped') + item(PAD + 420, C.none, 'No entry');
};

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface HabitNumbers { done: number; skipped: number; currentStreak: number; bestStreak: number }

// --------------------------------------------------------------------------
// 📊 One habit — a real calendar: Monday-first columns, one row per week, up to
// 12 weeks back (from the habit's first mark), then four soft stat tiles.
// --------------------------------------------------------------------------
const CAL_WEEKS = 12;
export const renderHabitCalendarPng = (name: string, byDate: Map<string, Status>, firstDate: string, today: string, n: HabitNumbers): Buffer => {
  // 🗓️ Monday of today's week, then back up to CAL_WEEKS weeks — but not before the first mark's week
  const mondayOf = (d: string) => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const lastMonday = mondayOf(today);
  let firstMonday = mondayOf(firstDate);
  const earliest = addDays(lastMonday, -7 * (CAL_WEEKS - 1));
  if (firstMonday < earliest) firstMonday = earliest;
  const weeks: string[] = [];
  for (let m = firstMonday; m <= lastMonday; m = addDays(m, 7)) weeks.push(m);

  const cell = 82, gap = 12, labelW = 150;
  const gridX = PAD + labelW, headY = 236, rowY0 = headY + 34;
  const gridBottom = rowY0 + weeks.length * (cell + gap);
  const tilesY = gridBottom + 40, tileH = 150;
  const H = tilesY + tileH + 170;
  const parts: string[] = [];

  ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach((l, i) =>
    parts.push(`<text x="${gridX + i * (cell + gap) + cell / 2}" y="${headY}" text-anchor="middle" font-size="30" font-weight="600" fill="${C.sub}">${l}</text>`));

  weeks.forEach((monday, r) => {
    const y = rowY0 + r * (cell + gap);
    parts.push(`<text x="${PAD}" y="${y + cell / 2 + 10}" font-size="28" fill="${C.sub}">${fmt(monday, { day: 'numeric', month: 'short' })}</text>`);
    for (let i = 0; i < 7; i++) {
      const d = addDays(monday, i);
      if (d > today) continue; // 🔮 future days stay blank
      const x = gridX + i * (cell + gap), s = byDate.get(d);
      parts.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="22" fill="${s ? C[s] : C.none}"/>`);
      if (d === today) parts.push(`<rect x="${x - 4}" y="${y - 4}" width="${cell + 8}" height="${cell + 8}" rx="25" fill="none" stroke="${C.todayRing}" stroke-width="2.5" stroke-dasharray="6 6"/>`);
    }
  });

  // 🔢 four stat tiles
  const tiles: Array<[string, number, string]> = [
    ['Done', n.done, C.done], ['Skipped', n.skipped, C.skipped], ['Current streak', n.currentStreak, '#E8EEF9'], ['Best streak', n.bestStreak, '#F3ECF8'],
  ];
  const tileW = (W - 2 * PAD - 3 * 20) / 4;
  tiles.forEach(([label, value, fill], i) => {
    const x = PAD + i * (tileW + 20);
    parts.push(`<rect x="${x}" y="${tilesY}" width="${tileW}" height="${tileH}" rx="26" fill="${fill}"/>`);
    parts.push(`<text x="${x + tileW / 2}" y="${tilesY + 78}" text-anchor="middle" font-size="56" font-weight="700" fill="${C.ink}">${value}</text>`);
    parts.push(`<text x="${x + tileW / 2}" y="${tilesY + 122}" text-anchor="middle" font-size="24" fill="${C.sub}">${label}</text>`);
  });
  parts.push(legendRow(H - 76));

  const subtitle = `${fmt(weeks[0], { day: 'numeric', month: 'short' })} – ${fmt(today, { day: 'numeric', month: 'short' })}`;
  return toPng(card(H, clipTitle(titleCase(name)), subtitle, parts.join('\n')));
};
const clipTitle = (s: string) => (s.length > 26 ? s.slice(0, 25).trimEnd() + '…' : s);

// --------------------------------------------------------------------------
// 📊📊 All habits — one row per habit, the last 14 days as squares in two week
// blocks, with the current streak on the right.
// --------------------------------------------------------------------------
const ALL_DAYS = 14;
export const renderAllHabitsPng = (habits: Array<GridHabit & { currentStreak: number }>, today: string): Buffer => {
  const rows = habits.slice(0, MAX_ROWS);
  const days = Array.from({ length: ALL_DAYS }, (_, i) => addDays(today, i - (ALL_DAYS - 1)));
  const cell = 34, cellH = 44, gap = 6, weekGap = 22, streakW = 70;
  const gridW = ALL_DAYS * cell + (ALL_DAYS - 1) * gap + (ALL_DAYS / 7 - 1) * (weekGap - gap);
  const gridX = W - PAD - streakW - gridW;
  const colX = (i: number) => gridX + i * (cell + gap) + Math.floor(i / 7) * (weekGap - gap);
  const headY = 232, rowY0 = headY + 34, rowH = 70;
  const H = rowY0 + rows.length * rowH + (habits.length > MAX_ROWS ? 50 : 0) + 150;
  const parts: string[] = [];

  // 🗓️ the date each week block starts, and a 🔥 column header
  for (let w = 0; w < ALL_DAYS / 7; w++) parts.push(`<text x="${colX(w * 7)}" y="${headY}" font-size="24" fill="${C.sub}">${fmt(days[w * 7], { day: 'numeric', month: 'short' })}</text>`);
  parts.push(`<text x="${W - PAD}" y="${headY}" text-anchor="end" font-size="24" fill="${C.sub}">Streak</text>`);

  rows.forEach((h, r) => {
    const y = rowY0 + r * rowH;
    parts.push(`<text x="${PAD}" y="${y + 36}" font-size="30" font-weight="600" fill="${C.ink}">${esc(h.name.length > 14 ? h.name.slice(0, 13).trimEnd() + '…' : h.name)}</text>`);
    days.forEach((d, i) => {
      const s = h.byDate.get(d);
      parts.push(`<rect x="${colX(i)}" y="${y + 3}" width="${cell}" height="${cellH}" rx="10" fill="${s ? C[s] : C.none}"/>`);
    });
    parts.push(`<text x="${W - PAD}" y="${y + 38}" text-anchor="end" font-size="32" font-weight="700" fill="${h.currentStreak ? C.brand : C.sub}">${h.currentStreak}</text>`);
  });
  if (habits.length > MAX_ROWS) parts.push(`<text x="${PAD}" y="${rowY0 + rows.length * rowH + 30}" font-size="28" fill="${C.sub}">…plus ${habits.length - MAX_ROWS} more</text>`);
  parts.push(legendRow(H - 76));

  return toPng(card(H, 'All habits', `Last 2 weeks  ·  ${fmt(days[0], { day: 'numeric', month: 'short' })} – ${fmt(today, { day: 'numeric', month: 'short' })}`, parts.join('\n')));
};
