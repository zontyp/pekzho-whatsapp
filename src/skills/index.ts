// ============================================================================
// 🧰 The skill registry — every skill pekzho knows lives in this list.
// Order matters for shortcuts: the first skill that claims a turn wins.
// ============================================================================

import type { Skill } from './types.ts';
import { habitsSkill } from './habits/index.ts';
import { attendanceSkill } from './attendance/index.ts';

export const SKILLS: Skill[] = [
  // 🕘 first: its commands are exact phrases, and "check in" must win even if
  // the user happens to be mid-"add habit" (it would otherwise become a habit name)
  attendanceSkill,
  habitsSkill,
  // ➕ next skill goes here
];
