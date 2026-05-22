export type MediaResolution =
  | 'MEDIA_RESOLUTION_UNSPECIFIED'
  | 'MEDIA_RESOLUTION_LOW'
  | 'MEDIA_RESOLUTION_MEDIUM'
  | 'MEDIA_RESOLUTION_HIGH';

export type StartSensitivity =
  | 'START_SENSITIVITY_UNSPECIFIED'
  | 'START_SENSITIVITY_HIGH'
  | 'START_SENSITIVITY_LOW';

export type EndSensitivity =
  | 'END_SENSITIVITY_UNSPECIFIED'
  | 'END_SENSITIVITY_HIGH'
  | 'END_SENSITIVITY_LOW';

export type ActivityHandling =
  | 'ACTIVITY_HANDLING_UNSPECIFIED'
  | 'START_OF_ACTIVITY_INTERRUPTS'
  | 'NO_INTERRUPTION';

export type TurnCoverage =
  | 'TURN_COVERAGE_UNSPECIFIED'
  | 'TURN_INCLUDES_ONLY_ACTIVITY'
  | 'TURN_INCLUDES_ALL_INPUT'
  | 'TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO';

export type SpeechLanguageCode =
  | 'en-US'
  | 'en-IN'
  | 'en-GB'
  | 'en-AU';

export type LiveSettings = {
  videoFps: number;
  frameWidth: number;
  frameHeight: number;
  jpegQuality: number;
  mediaResolution: MediaResolution;
  temperature: number;
  topP: number;
  topK: number;
  speechLanguageCode: SpeechLanguageCode;
  systemInstruction: string;
  autoActivityDetection: boolean;
  startSensitivity: StartSensitivity;
  endSensitivity: EndSensitivity;
  prefixPaddingMs: number;
  silenceDurationMs: number;
  activityHandling: ActivityHandling;
  turnCoverage: TurnCoverage;
  inputTranscription: boolean;
  outputTranscription: boolean;
  sessionResumption: boolean;
  contextCompression: boolean;
  contextTriggerTokens: number;
  audioChunkMs: number;
};

export type SetupShape = 'setup' | 'config';

export type NativeVideoFrame = {
  data: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
  quality: number;
  targetFps: number;
  timestamp: number;
  frameId: number;
};

export type NativeAudioChunk = {
  data: string;
  bytes: number;
  sampleRate: number;
  chunkMs: number;
  timestamp: number;
};

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export type AppLog = {
  id: number;
  level: LogLevel;
  message: string;
  at: string;
};
