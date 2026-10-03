// ============================================================================
// 🧑‍💻 Build a UserContext — "who is this, what day is it for them, and how do I
// talk back". Used for live turns AND for scheduled jobs (reminders), so both
// paths send messages the exact same way.
// ============================================================================

import { localDate } from '../clock.ts';
import { sendButtons, sendTemplate, sendText, type ReplyButton } from '../whatsapp.ts';
import type { UserContext } from '../skills/types.ts';

export const userContextFor = (userId: string, name?: string): UserContext => ({
  userId,
  name,
  today: localDate(),
  sayText: async (text: string) => {
    const wamid = await sendText(userId, text);
    console.log(`📤 to=${userId} wamid=${wamid} text=${JSON.stringify(Array.from(text).slice(0, 120).join(''))}`);
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
