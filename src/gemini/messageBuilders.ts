import {GEMINI_LIVE_MODEL} from '../config/geminiConfig';
import type {LiveSettings, NativeAudioChunk, NativeVideoFrame, SetupShape} from './types';

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

export function buildSetupMessage(
  settings: LiveSettings,
  shape: SetupShape,
  sessionHandle?: string,
) {
  const setup = compactObject({
    model: `models/${GEMINI_LIVE_MODEL}`,
    generationConfig: compactObject({
      responseModalities: ['AUDIO'],
      temperature: settings.temperature,
      topP: settings.topP,
      topK: Math.round(settings.topK),
      mediaResolution: settings.mediaResolution,
      speechConfig: {
        languageCode: settings.speechLanguageCode,
      },
    }),
    systemInstruction: {
      parts: [{text: settings.systemInstruction}],
    },
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: !settings.autoActivityDetection,
        startOfSpeechSensitivity: settings.startSensitivity,
        endOfSpeechSensitivity: settings.endSensitivity,
        prefixPaddingMs: Math.round(settings.prefixPaddingMs),
        silenceDurationMs: Math.round(settings.silenceDurationMs),
      },
      activityHandling: settings.activityHandling,
      turnCoverage: settings.turnCoverage,
    },
    inputAudioTranscription: settings.inputTranscription ? {} : undefined,
    outputAudioTranscription: settings.outputTranscription ? {} : undefined,
    sessionResumption: settings.sessionResumption
      ? compactObject({handle: sessionHandle})
      : undefined,
    contextWindowCompression: settings.contextCompression
      ? {
          slidingWindow: {},
          triggerTokens: Math.round(settings.contextTriggerTokens),
        }
      : undefined,
  });

  if (shape === 'setup') {
    return {setup};
  }

  return {
    config: compactObject({
      model: setup.model,
      responseModalities: ['AUDIO'],
      mediaResolution: settings.mediaResolution,
      temperature: settings.temperature,
      topP: settings.topP,
      topK: Math.round(settings.topK),
      speechConfig: {
        languageCode: settings.speechLanguageCode,
      },
      systemInstruction: setup.systemInstruction,
      realtimeInputConfig: setup.realtimeInputConfig,
      inputAudioTranscription: setup.inputAudioTranscription,
      outputAudioTranscription: setup.outputAudioTranscription,
      sessionResumption: setup.sessionResumption,
      contextWindowCompression: setup.contextWindowCompression,
    }),
  };
}

export function buildAudioInputMessage(chunk: NativeAudioChunk) {
  return {
    realtimeInput: {
      audio: {
        data: chunk.data,
        mimeType: `audio/pcm;rate=${chunk.sampleRate}`,
      },
    },
  };
}

export function buildVideoInputMessage(frame: NativeVideoFrame) {
  return {
    realtimeInput: {
      video: {
        data: frame.data,
        mimeType: frame.mimeType,
      },
    },
  };
}

export function buildAudioStreamEndMessage() {
  return {
    realtimeInput: {
      audioStreamEnd: true,
    },
  };
}
