// ============================================================================
// 🧑‍💻 Build a UserContext — "who is this, what day is it for them, and how do I
// talk back". Used for live turns AND for scheduled jobs (reminders), so both
// paths send messages the exact same way.
// ============================================================================

import { localDate } from '../clock.ts';
import { sendButtons, sendTemplate, sendText, type ReplyButton } from '../whatsapp.ts';
import type { UserContext } from '../skills/types.ts';

// 👋 What to call someone in "Hi ___": their first name — but a leading title
// keeps its name attached, so "Mr. Tejkumar Ahuja" → "Mr. Tejkumar", not "Mr.".
const TITLES = /^(mr|mrs|ms|miss|dr|prof|shri|smt|sri|kumari)\.?$/i;
export const greetingName = (fullName: string | null | undefined): string | undefined => {
  const words = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return undefined;
  return TITLES.test(words[0]) && words[1] ? `${words[0]} ${words[1]}` : words[0];
};

export const userContextFor =(userId: string, name?: string): UserContext => ({
  userId,
  name,
  today: localDate(),
  sayText: async (text: string) => {
    const wamid = await sendText(userId, text);
    // 🙈 sign-in links are bearer secrets (whoever holds one drives that Chrome) — keep them out of docker logs
    const loggable = text.replace(/(\/attendance\/login\/)[\w-]+/g, '$1…');
    console.log(`📤 to=${userId} wamid=${wamid} text=${JSON.stringify(Array.from(loggable).slice(0, 120).join(''))}`);
  },
  sayWithButtons: async (text: string, buttons: ReplyButton[]) => {
    const wamid = await sendButtons(userId, text, buttons);
    console.log(`📤 to=${userId} wamid=${wamid} buttons=${buttons.map((b) => b.id).join(',')}`);
  },
  sayTemplate: async (name, language, bodyParams, quickReplyPayloads = []) => {
    const wamid = await sendTemplate(userId, name, language, bodyParams, quickReplyPayloads);
    console.log(`📤 to=${userId} wamid=${wamid} template=${name} params=${JSON.stringify(bodyParams)}`);
  },
});
