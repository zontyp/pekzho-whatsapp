// ============================================================================
// 🧰 The skill registry — every skill pekzho knows lives in this list.
// Order matters for shortcuts: the first skill that claims a turn wins.
// ============================================================================

import type { Skill } from './types.ts';
import { habitsSkill } from './habits/index.ts';

export const SKILLS: Skill[] = [
  habitsSkill,
  // ➕ next skill goes here
];
