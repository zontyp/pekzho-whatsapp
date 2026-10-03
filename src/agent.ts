// ============================================================================
// 🧠 The agent's brain. Today it has exactly one thought: "Hello World". 🌍
// This is THE file to grow — LLM calls, memory, tools, per-user sessions — while
// server.ts (webhook plumbing) and whatsapp.ts (Graph API) stay boring.
// ============================================================================

export interface IncomingTurn {
  from: string;          // sender's phone, E.164 without "+"
  senderName?: string;   // WhatsApp profile name, if Meta sent one
  type: string;          // text | image | audio | ...
  text?: string;         // present for type=text
}

// 🎯 Decide what to say back. Async on purpose so swapping in an LLM later
// doesn't ripple through the callers.
export const replyTo = async (_turn: IncomingTurn): Promise<string> => {
  return 'Hello World';
};
