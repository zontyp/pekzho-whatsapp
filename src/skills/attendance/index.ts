// ============================================================================
// 🕘 Attendance skill — "check in" on WhatsApp → pekzho checks you in on
// Razorpay Payroll. Second pekzho skill (after habits).
//
// How a user experiences it:
//   first time   → "check in" → a one-time sign-in link (Google) → ✅ linked →
//                  pekzho checks them in right away
//   every day    → "check in" → ⏳ (~30–60s) → "✅ Checked in at 9:42 AM"
//   now & then   → Google wants them again → a fresh link, then it carries on
//
// The heavy lifting lives next door:
//   razorpay.ts    the Chrome-driving check-in/out (proven by hand first)
//   login-link.ts  the one-time sign-in page that follows Google's popup
//   store.ts       attendance_accounts (which saved browser profile is theirs)
//
// Runs are SLOW (a real browser), so they never block the chat: the shortcut /
// tool kicks a background job and the job talks to the user when it's done.
// One job per user at a time — a double "check in" can't double-click. 🚦
// ============================================================================

import { Type, type TSchema } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { browserbaseEnabled, createBrowserProfile, deleteBrowserProfile } from '../../browserbase.ts';
import { localDate } from '../../clock.ts';
import type { InboundTurn, Skill, UserContext } from '../types.ts';
import * as store from './store.ts';
import { friendlyTime, runAttendance, type AttendanceAction, type AttendanceResult } from './razorpay.ts';
import { startLoginLink } from './login-link.ts';

// 🗣️ Exact phrases the shortcut answers (after lower-casing + squashing spaces).
const SAYS_CHECK_IN  = /^(check[\s-]?in|punch[\s-]?in|clock[\s-]?in|mark (my )?attendance)( now)?[.!]*$/;
const SAYS_CHECK_OUT = /^(check[\s-]?out|punch[\s-]?out|clock[\s-]?out)( now)?[.!]*$/;
const SAYS_STATUS    = /^(attendance|attendance status|my attendance|did i check in\??)$/;
const SAYS_LINK      = /^(link|connect) (attendance|razorpay)$/;
const SAYS_UNLINK    = /^(unlink|disconnect|logout|log out of) (attendance|razorpay)$/;

type Job = AttendanceAction | 'link';
const jobRunningFor = new Set<string>(); // userIds with a job in flight

const ACTION_WORDS: Record<AttendanceAction, { doing: string; done: string }> = {
  'check-in':  { doing: '⏳ Checking you in on Razorpay… (takes ~30s)', done: '✅ Checked in' },
  'check-out': { doing: '⏳ Checking you out on Razorpay… (takes ~30s)', done: '👋 Checked out' },
  'status':    { doing: '⏳ Looking up today\'s attendance…', done: '' },
};

// 💬 Turn a run result into the one WhatsApp message the user sees.
const describeResult = (r: AttendanceResult): string => {
  switch (r.outcome) {
    case 'done': {
      // 🔁 a repeat check-out moves the time on Razorpay — say what it replaced
      const replaced = r.action === 'check-out' && r.status.checkedOutAt ? ` _(updated from ${friendlyTime(r.status.checkedOutAt)})_` : '';
      return `${ACTION_WORDS[r.action].done} at *${r.time}* 🎉${replaced}`;
    }
    case 'already':
      // ☝️ only check-in can be "already" — Razorpay allows one check-in a day
      return r.status.checkedOutAt
        ? `👍 You already checked in (*${r.time}*) and out (*${friendlyTime(r.status.checkedOutAt)}*) today — Razorpay allows one check-in a day. Send *check out* again to update your check-out time.`
        : `👍 You're already checked in today (at *${r.time}*). Send *check out* when you leave.`;
    case 'status': {
      const s = r.status;
      if (!s.checkedInAt) return '📋 Not checked in yet today. Send *check in* when you start.';
      return `📋 Checked in at *${friendlyTime(s.checkedInAt)}*${s.checkedOutAt ? `, out at *${friendlyTime(s.checkedOutAt)}*` : ' — not checked out yet'}.`;
    }
    case 'refused':
      return `⚠️ I couldn't do that — ${r.reason}`;
    case 'needs-login':
      return ''; // handled by the caller (sends a link)
  }
};

// 🔗 Send a sign-in link; when they finish, optionally carry on with `then`.
const sendSignInLink = async (user: UserContext, browserProfileId: string, intro: string, then?: AttendanceAction) => {
  const url = await startLoginLink(user.userId, browserProfileId, {
    whenLinked: async () => {
      await store.markAttendanceLinked(user.userId);
      if (!then || then === 'status') {
        await user.sayText('✅ Razorpay is linked! From now on just send *check in* / *check out*.');
        return;
      }
      await user.sayText(`✅ Razorpay is linked! ${ACTION_WORDS[then].doing}`);
      await runAndReport(user, browserProfileId, then, false);
    },
    whenAbandoned: async () => {
      await user.sayText('⌛ The sign-in link expired before you finished. Send *check in* again for a new one.');
    },
  });
  await user.sayText(`${intro}\n👉 ${url}\n_(valid 10 minutes — tap *Sign in with Google* there)_`);
};

// 🎬 One run + its reply. needs-login → a link (at most once per job).
const runAndReport = async (user: UserContext, browserProfileId: string, action: AttendanceAction, mayAskToSignIn: boolean) => {
  const result = await runAttendance(browserProfileId, action, localDate());
  console.log(`🕘 ${user.userId} ${action} → ${result.outcome}`);
  if (result.outcome === 'needs-login') {
    if (!mayAskToSignIn) { await user.sayText('😕 Razorpay still wants a sign-in. Send *link attendance* to try again.'); return; }
    await sendSignInLink(user, browserProfileId, '🔐 Razorpay needs you to sign in with Google again (happens now and then).', action);
    return;
  }
  if (result.outcome === 'done') await store.stampPunch(user.userId);
  await user.sayText(describeResult(result));
};

// 🚀 The single entry point for shortcuts AND LLM tools. Fire-and-forget:
// returns a short line describing what was started (tools hand it to the LLM).
export const startAttendanceJob = (user: UserContext, job: Job): string => {
  if (!browserbaseEnabled()) {
    void user.sayText('🕘 Attendance isn\'t switched on yet on my side — sorry!').catch(() => {});
    return 'Attendance is not configured on the server; told the user.';
  }
  if (jobRunningFor.has(user.userId)) {
    void user.sayText('⏳ Still working on your last attendance request — one sec!').catch(() => {});
    return 'An attendance job is already running for this user; told them to wait.';
  }
  jobRunningFor.add(user.userId);
  void (async () => {
    try {
      let account = await store.getAttendanceAccount(user.userId);
      if (!account) {
        const browserProfileId = await createBrowserProfile();
        await store.saveNewAttendanceAccount(user.userId, browserProfileId);
        account = { browserProfileId, linked: false };
      }
      if (job === 'link' || !account.linked) {
        await sendSignInLink(user, account.browserProfileId,
          job === 'link' ? '🔗 Let\'s link your Razorpay Payroll account.'
                         : '🔗 First, link your Razorpay Payroll account — one time only.',
          job === 'link' ? undefined : job);
        return;
      }
      await user.sayText(ACTION_WORDS[job].doing);
      await runAndReport(user, account.browserProfileId, job, true);
    } catch (e: any) {
      console.error(`🕘 attendance ${job} for ${user.userId} crashed: ${e.message}`);
      await user.sayText(/→ 429|→ 402|concurren/i.test(e.message)
        ? '🚦 My browser service is busy right now — please try again in a minute.'
        : '😵 Something went wrong talking to Razorpay. Please try again in a minute.').catch(() => {});
    } finally {
      jobRunningFor.delete(user.userId);
    }
  })();
  return job === 'link' ? 'Started linking; the sign-in link goes straight to the user.'
                        : `Started ${job}; the result goes straight to the user (takes ~30–60s).`;
};

// 🗑️ "unlink attendance" — forget the profile here AND at Browserbase.
const unlinkAttendance = async (user: UserContext): Promise<string> => {
  const account = await store.getAttendanceAccount(user.userId);
  if (!account) { await user.sayText('🤷 Razorpay isn\'t linked, nothing to remove.'); return 'Nothing was linked.'; }
  await store.forgetAttendanceAccount(user.userId);
  await deleteBrowserProfile(account.browserProfileId).catch((e) => console.warn(`🗑️ profile delete failed: ${e.message}`));
  await user.sayText('🗑️ Done — I\'ve forgotten your Razorpay sign-in. Send *check in* any time to link again.');
  return 'Unlinked and deleted the saved sign-in.';
};

// --------------------------------------------------------------------------
// ⚡ Shortcut — exact commands, no LLM.
// --------------------------------------------------------------------------
const attendanceShortcut = async (turn: InboundTurn, user: UserContext): Promise<boolean> => {
  if (turn.kind !== 'text') return false;
  const said = turn.text.trim().toLowerCase().replace(/^\//, '').replace(/\s+/g, ' ');
  if (SAYS_CHECK_IN.test(said))  { startAttendanceJob(user, 'check-in'); return true; }
  if (SAYS_CHECK_OUT.test(said)) { startAttendanceJob(user, 'check-out'); return true; }
  if (SAYS_STATUS.test(said))    { startAttendanceJob(user, 'status'); return true; }
  if (SAYS_LINK.test(said))      { startAttendanceJob(user, 'link'); return true; }
  if (SAYS_UNLINK.test(said))    { await unlinkAttendance(user); return true; }
  return false;
};

// --------------------------------------------------------------------------
// 🛠️ LLM tools — same abilities for free-form asks ("log me in for work").
// Each one terminates the turn: the job replies by itself when it's done.
// --------------------------------------------------------------------------
const defineTool = <T extends TSchema>(tool: AgentTool<T>): AgentTool<any> => tool;
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], details: {}, terminate: true });

const attendanceTools = (user: UserContext): AgentTool<any>[] => [
  defineTool({
    name: 'attendance_check_in',
    label: 'Check in',
    description: 'Check the user in for work on Razorpay Payroll (marks today\'s attendance). Replies to the user by itself in ~30-60s; first time it sends a sign-in link instead.',
    parameters: Type.Object({}),
    execute: async () => text(startAttendanceJob(user, 'check-in')),
  }),
  defineTool({
    name: 'attendance_check_out',
    label: 'Check out',
    description: 'Check the user out of work on Razorpay Payroll. Replies to the user by itself.',
    parameters: Type.Object({}),
    execute: async () => text(startAttendanceJob(user, 'check-out')),
  }),
  defineTool({
    name: 'attendance_status',
    label: 'Attendance status',
    description: 'Look up whether the user has checked in / out on Razorpay today. Read-only; replies to the user by itself.',
    parameters: Type.Object({}),
    execute: async () => text(startAttendanceJob(user, 'status')),
  }),
  defineTool({
    name: 'attendance_unlink',
    label: 'Unlink Razorpay',
    description: 'Forget the user\'s saved Razorpay sign-in. Only when they clearly ask to unlink / disconnect / log out of attendance.',
    parameters: Type.Object({}),
    execute: async () => text(await unlinkAttendance(user)),
  }),
];

export const attendanceSkill: Skill = {
  name: 'attendance',
  prompt: [
    '## Skill: work attendance on Razorpay Payroll 🕘',
    '- "check in", "I\'m at work", "mark my attendance" → attendance_check_in. Leaving / done for the day → attendance_check_out.',
    '- "did I check in?" → attendance_status. Unlink / disconnect → attendance_unlink.',
    '- These tools reply to the user by themselves (a real browser does it, ~30-60s). Do NOT add text, and never claim it worked — you don\'t know yet.',
    '- Commands they can type: *check in*, *check out*, *attendance*, *unlink attendance*.',
  ].join('\n'),
  tools: attendanceTools,
  shortcut: attendanceShortcut,
  describeState: async (user) => {
    const account = await store.getAttendanceAccount(user.userId);
    return `- razorpay attendance: ${account?.linked ? 'linked' : 'not linked (first check in sends a sign-in link)'}`;
  },
  vocabulary: async () => ['check in', 'check out', 'attendance', 'Razorpay'],
  // 👋 no welcome entry on purpose — only Razorpay Payroll users care, and the
  // welcome card should stay about habits for everyone else
};
