export const GEMINI_API_KEY = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

export const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';

export const GEMINI_LIVE_WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export function buildGeminiWsUrl(apiKey: string = GEMINI_API_KEY): string {
  return `${GEMINI_LIVE_WS_ENDPOINT}?key=${encodeURIComponent(apiKey.trim())}`;
}
