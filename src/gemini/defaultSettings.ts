import type {LiveSettings} from './types';

export const DEFAULT_LIVE_SETTINGS: LiveSettings = {
  videoFps: 2,
  frameWidth: 640,
  frameHeight: 480,
  jpegQuality: 65,
  mediaResolution: 'MEDIA_RESOLUTION_LOW',
  temperature: 0.7,
  topP: 0.95,
  topK: 32,
  speechLanguageCode: 'en-US',
  systemInstruction:
    'You are Gemini in a mobile video call test app. Always listen and respond in English. If the input sounds ambiguous or multilingual, interpret it as English when possible. Respond briefly and use what you can hear and see.',
  autoActivityDetection: true,
  startSensitivity: 'START_SENSITIVITY_HIGH',
  endSensitivity: 'END_SENSITIVITY_HIGH',
  prefixPaddingMs: 150,
  silenceDurationMs: 650,
  activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
  turnCoverage: 'TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO',
  inputTranscription: true,
  outputTranscription: true,
  sessionResumption: true,
  contextCompression: true,
  contextTriggerTokens: 24000,
  audioChunkMs: 40,
};
