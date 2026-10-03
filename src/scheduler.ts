// ============================================================================
// ⏲️ The world's smallest cron — ticks once a minute (aligned to :00) and asks
// every skill "anything to do at HH:MM?". FlowTalkr used Quartz; one in-process
// timer is plenty for a single container. Each skill de-dupes its own work via
// the DB (e.g. wa_users.last_reminded_on), so a restart never double-sends.
// ============================================================================

import { localTime } from './clock.ts';
import { SKILLS } from './skills/index.ts';

const tick = async () => {
  const hhmm = localTime();
  for (const skill of SKILLS) {
    if (!skill.everyMinute) continue;
    try { await skill.everyMinute(hhmm); }
    catch (e: any) { console.error(`⏲️  ${skill.name}.everyMinute(${hhmm}) failed: ${e.message}`); }
  }
};

export const startScheduler = () => {
  const msToNextMinute = 60_000 - (Date.now() % 60_000) + 500; // +0.5s so we're safely inside the minute
  setTimeout(() => { void tick(); setInterval(() => void tick(), 60_000); }, msToNextMinute);
  console.log('⏲️  scheduler armed (1-minute ticks)');
};
