import {
  NativeEventEmitter,
  NativeModules,
  Platform,
} from 'react-native';
import type {NativeAudioChunk, NativeVideoFrame} from '../gemini/types';

type GeminiAudioBridgeType = {
  startRecording(sampleRate: number, chunkMs: number): Promise<void>;
  stopRecording(): Promise<void>;
  startCameraCapture(
    fps: number,
    jpegQuality: number,
    targetWidth: number,
    targetHeight: number,
    cameraFacing: 'front' | 'back',
  ): Promise<void>;
  stopCameraCapture(): Promise<void>;
  startPlayback(sampleRate: number): Promise<void>;
  enqueuePlaybackChunk(base64Pcm: string): Promise<number>;
  clearPlaybackQueue(): Promise<void>;
  stopPlayback(): Promise<void>;
};

const nativeAudio = NativeModules.GeminiAudioBridge as
  | GeminiAudioBridgeType
  | undefined;

const eventEmitterModule: any =
  nativeAudio ??
  {
    addListener: () => undefined,
    removeListeners: () => undefined,
  };

export const GeminiAudioBridge: GeminiAudioBridgeType = nativeAudio ?? {
  startRecording: async () => {
    throw new Error('GeminiAudioBridge is only available on Android.');
  },
  stopRecording: async () => undefined,
  startCameraCapture: async () => {
    throw new Error('GeminiAudioBridge is only available on Android.');
  },
  stopCameraCapture: async () => undefined,
  startPlayback: async () => {
    throw new Error('GeminiAudioBridge is only available on Android.');
  },
  enqueuePlaybackChunk: async () => 0,
  clearPlaybackQueue: async () => undefined,
  stopPlayback: async () => undefined,
};

export const geminiNativeEvents =
  Platform.OS === 'android'
    ? new NativeEventEmitter(eventEmitterModule as any)
    : new NativeEventEmitter(eventEmitterModule as any);

export type GeminiNativeEventMap = {
  GeminiAudioChunk: NativeAudioChunk;
  GeminiVideoFrame: NativeVideoFrame;
  GeminiNativeError: {source: string; message: string};
  GeminiNativeInfo: {source: string; message: string};
};
