import type {NativeAudioChunk, NativeVideoFrame} from '../gemini/types';

export type LiveMetrics = {
  framesSent: number;
  framesDropped: number;
  lastFrameBytes: number;
  lastFrameSize: string;
  jpegQuality: number;
  targetFps: number;
  actualFps: number;
  videoBytesSent: number;
  audioChunksSent: number;
  audioBytesSent: number;
  audioBytesReceived: number;
  audioChunksReceived: number;
  playbackQueuedChunks: number;
  reconnects: number;
  messagesReceived: number;
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
  lastLatencyMs: number;
};

export const EMPTY_METRICS: LiveMetrics = {
  framesSent: 0,
  framesDropped: 0,
  lastFrameBytes: 0,
  lastFrameSize: '0 x 0',
  jpegQuality: 0,
  targetFps: 0,
  actualFps: 0,
  videoBytesSent: 0,
  audioChunksSent: 0,
  audioBytesSent: 0,
  audioBytesReceived: 0,
  audioChunksReceived: 0,
  playbackQueuedChunks: 0,
  reconnects: 0,
  messagesReceived: 0,
  promptTokens: 0,
  responseTokens: 0,
  totalTokens: 0,
  lastLatencyMs: 0,
};

const FPS_WINDOW_MS = 5000;

export class MetricsTracker {
  private frameTimes: number[] = [];
  private lastInputAt = 0;
  private value: LiveMetrics = {...EMPTY_METRICS};

  snapshot(): LiveMetrics {
    return {...this.value};
  }

  reset() {
    this.frameTimes = [];
    this.lastInputAt = 0;
    this.value = {...EMPTY_METRICS};
  }

  markReconnect() {
    this.value.reconnects += 1;
  }

  markMessageReceived() {
    this.value.messagesReceived += 1;
  }

  markVideoSent(frame: NativeVideoFrame) {
    const now = Date.now();
    this.frameTimes.push(now);
    this.frameTimes = this.frameTimes.filter(item => now - item <= FPS_WINDOW_MS);
    this.lastInputAt = now;
    this.value.framesSent += 1;
    this.value.lastFrameBytes = frame.bytes;
    this.value.lastFrameSize = `${frame.width} x ${frame.height}`;
    this.value.jpegQuality = frame.quality;
    this.value.targetFps = frame.targetFps;
    this.value.actualFps = Number(
      ((this.frameTimes.length / FPS_WINDOW_MS) * 1000).toFixed(2),
    );
    this.value.videoBytesSent += frame.bytes;
  }

  markFrameDropped() {
    this.value.framesDropped += 1;
  }

  markAudioSent(chunk: NativeAudioChunk) {
    this.lastInputAt = Date.now();
    this.value.audioChunksSent += 1;
    this.value.audioBytesSent += chunk.bytes;
  }

  markAudioReceived(bytes: number) {
    this.value.audioChunksReceived += 1;
    this.value.audioBytesReceived += bytes;
    if (this.lastInputAt > 0) {
      this.value.lastLatencyMs = Date.now() - this.lastInputAt;
    }
  }

  markPlaybackQueueDepth(depth: number) {
    this.value.playbackQueuedChunks = depth;
  }

  markUsage(usage: {
    promptTokenCount?: number;
    responseTokenCount?: number;
    totalTokenCount?: number;
  }) {
    this.value.promptTokens = usage.promptTokenCount ?? this.value.promptTokens;
    this.value.responseTokens =
      usage.responseTokenCount ?? this.value.responseTokens;
    this.value.totalTokens = usage.totalTokenCount ?? this.value.totalTokens;
  }
}
