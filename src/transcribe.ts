// ============================================================================
// 🎙️ Voice → text. WhatsApp voice notes (ogg/opus) go straight to OpenAI's
// transcription API — the same model the Claude+Pi mic dictation uses
// (pektown-api /llm/transcribe → gpt-4o-mini-transcribe, ~$0.003/min).
// pekzho is an operator service (not a tenant container), so it holds the
// operator key directly, like it does the DeepSeek key.
// ============================================================================

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
// 🔧 gpt-4o-mini-transcribe = Claude+Pi's model; set gpt-4o-transcribe for more accuracy (~2× price)
const MODEL = process.env.PEKZHO_TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe';
const TIMEOUT_MS = 60_000;
if (!OPENAI_API_KEY) console.warn('⚠️  OPENAI_API_KEY is empty — voice notes will get a "please type it" reply');

// 🗂️ OpenAI sniffs the format from the filename extension, so name it right.
const extensionFor = (mimeType: string): string => {
  const m = mimeType.toLowerCase();
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('webm')) return 'webm';
  return 'ogg';
};

export const transcriptionEnabled = () => Boolean(OPENAI_API_KEY);

export const transcribeAudio = async (audio: Buffer, mimeType: string, vocabulary: string[] = []): Promise<string> => {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType.split(';')[0] }), `voice.${extensionFor(mimeType)}`);
  form.append('model', MODEL);
  // 🗣️ Nudge: our users mostly speak English / Hindi / Hinglish about habits.
  // 📚 …and the user's own words (habit names) so they're spelled the way we stored them.
  const hints = vocabulary.length ? ` Words they may use: ${vocabulary.slice(0, 40).join(', ')}.` : '';
  form.append('prompt', `A WhatsApp voice note to a habit-tracking assistant. May be English, Hindi or Hinglish.${hints}`);
  const started = Date.now();
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI transcribe ${r.status}: ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
  const text = String(json?.text ?? '').trim();
  console.log(`🎙️ transcribed ${audio.length} bytes in ${Date.now() - started}ms (${MODEL}) → ${JSON.stringify(text.slice(0, 120))}`);
  return text;
};
