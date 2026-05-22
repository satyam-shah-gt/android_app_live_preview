import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Image,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {buildGeminiWsUrl, GEMINI_API_KEY} from './src/config/geminiConfig';
import {DEFAULT_LIVE_SETTINGS} from './src/gemini/defaultSettings';
import {
  buildAudioInputMessage,
  buildAudioStreamEndMessage,
  buildSetupMessage,
  buildVideoInputMessage,
} from './src/gemini/messageBuilders';
import type {
  ActivityHandling,
  AppLog,
  EndSensitivity,
  LiveSettings,
  MediaResolution,
  NativeAudioChunk,
  NativeVideoFrame,
  SpeechLanguageCode,
  SetupShape,
  StartSensitivity,
  TurnCoverage,
} from './src/gemini/types';
import {EMPTY_METRICS, MetricsTracker, type LiveMetrics} from './src/metrics/liveMetrics';
import {
  GeminiAudioBridge,
  geminiNativeEvents,
} from './src/native/GeminiNative';

const AUDIO_INPUT_RATE = 16000;
const AUDIO_OUTPUT_RATE = 24000;
const MAX_LOGS = 160;

type CameraPermissionState =
  | 'checking'
  | 'granted'
  | 'denied'
  | 'never_ask_again'
  | 'unavailable';

function arrayBufferToAscii(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let text = '';
  for (let index = 0; index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index]);
  }
  return text;
}

function arrayBufferToHex(data: ArrayBuffer): string {
  return Array.from(new Uint8Array(data))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join(' ')
    .slice(0, 220);
}

function describeWsPayload(data: unknown): string {
  if (typeof data === 'string') {
    return data.slice(0, 220);
  }
  if (data instanceof ArrayBuffer) {
    const ascii = arrayBufferToAscii(data);
    return `ArrayBuffer(${data.byteLength}) ascii=${JSON.stringify(
      ascii.slice(0, 160),
    )} hex=${arrayBufferToHex(data)}`;
  }
  if (data && typeof data === 'object') {
    try {
      return JSON.stringify(data).slice(0, 220);
    } catch {
      return Object.prototype.toString.call(data);
    }
  }
  return String(data);
}

async function parseWsPayload(data: unknown): Promise<any> {
  if (typeof data === 'string') {
    return JSON.parse(data);
  }
  if (data instanceof ArrayBuffer) {
    return JSON.parse(arrayBufferToAscii(data));
  }
  if (data && typeof data === 'object') {
    const maybeBlob = data as {text?: () => Promise<string>};
    if (typeof maybeBlob.text === 'function') {
      return JSON.parse(await maybeBlob.text());
    }
    return data;
  }
  return JSON.parse(String(data));
}

function App(): React.JSX.Element {
  const [settings, setSettings] = useState<LiveSettings>(DEFAULT_LIVE_SETTINGS);
  const [logs, setLogs] = useState<AppLog[]>([]);
  const [metrics, setMetrics] = useState<LiveMetrics>(EMPTY_METRICS);
  const [status, setStatus] = useState('idle');
  const [callActive, setCallActive] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [cameraPermissionGranted, setCameraPermissionGranted] =
    useState(Platform.OS !== 'android');
  const [cameraPermissionStatus, setCameraPermissionStatus] =
    useState<CameraPermissionState>(
      Platform.OS === 'android' ? 'checking' : 'granted',
    );
  const [speakerOn, setSpeakerOn] = useState(true);
  const [sessionHandle, setSessionHandle] = useState<string | undefined>();
  const [inputTranscript, setInputTranscript] = useState('');
  const [outputTranscript, setOutputTranscript] = useState('');
  const [latestCameraFrameUri, setLatestCameraFrameUri] = useState<
    string | undefined
  >();

  const wsRef = useRef<WebSocket | null>(null);
  const metricsRef = useRef(new MetricsTracker());
  const logIdRef = useRef(0);
  const activeRef = useRef(false);
  const setupDoneRef = useRef(false);
  const setupShapeRef = useRef<SetupShape>('setup');
  const retryingSetupRef = useRef(false);
  const sessionHandleRef = useRef<string | undefined>(undefined);
  const speakerOnRef = useRef(true);
  const micOnRef = useRef(true);
  const firstCameraFrameLoggedRef = useRef(false);
  const waitingForSetupFrameLoggedRef = useRef(false);
  const cameraPermissionRequestRef = useRef<Promise<boolean> | null>(null);
  const closedSocketFrameLoggedRef = useRef(false);

  const apiKeyReady =
    String(GEMINI_API_KEY).trim() !== '' &&
    String(GEMINI_API_KEY) !== 'PASTE_YOUR_GEMINI_API_KEY_HERE';

  const addLog = useCallback((level: AppLog['level'], message: string) => {
    const consoleMessage = `[GeminiLiveTest] ${message}`;
    if (level === 'error') {
      console.error(consoleMessage);
    } else if (level === 'warn') {
      console.warn(consoleMessage);
    } else {
      console.log(consoleMessage);
    }

    const entry: AppLog = {
      id: ++logIdRef.current,
      level,
      message,
      at: new Date().toLocaleTimeString(),
    };
    setLogs(current => [entry, ...current].slice(0, MAX_LOGS));
  }, []);

  const refreshMetrics = useCallback(() => {
    setMetrics(metricsRef.current.snapshot());
  }, []);

  const updateSetting = useCallback(
    <K extends keyof LiveSettings>(key: K, value: LiveSettings[K]) => {
      setSettings(current => ({...current, [key]: value}));
    },
    [],
  );

  const sendJson = useCallback((payload: unknown) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  const requestCameraPermission = useCallback(
    async (reason: string) => {
      if (Platform.OS !== 'android') {
        setCameraPermissionGranted(true);
        setCameraPermissionStatus('granted');
        return true;
      }

      if (cameraPermissionRequestRef.current) {
        addLog('debug', `Camera permission request already active (${reason})`);
        return cameraPermissionRequestRef.current;
      }

      const request = (async () => {
        const alreadyGranted = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.CAMERA,
        );
        if (alreadyGranted) {
          setCameraPermissionGranted(true);
          setCameraPermissionStatus('granted');
          addLog('info', `Camera permission already granted (${reason})`);
          return true;
        }

        addLog('info', `Requesting camera permission (${reason})`);
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.CAMERA,
        );
        const granted = result === PermissionsAndroid.RESULTS.GRANTED;
        setCameraPermissionGranted(granted);
        setCameraPermissionStatus(
          result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
            ? 'never_ask_again'
            : granted
              ? 'granted'
              : 'denied',
        );
        addLog(
          granted ? 'info' : 'warn',
          `Camera permission result (${reason}): ${result}`,
        );
        return granted;
      })();

      cameraPermissionRequestRef.current = request;
      try {
        return await request;
      } finally {
        cameraPermissionRequestRef.current = null;
      }
    },
    [addLog],
  );

  const requestPermissions = useCallback(async () => {
    if (Platform.OS !== 'android') {
      return true;
    }
    const cameraGranted = await requestCameraPermission('start call');
    const audioResult = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    );
    addLog('info', `Microphone permission result (start call): ${audioResult}`);
    return cameraGranted && audioResult === PermissionsAndroid.RESULTS.GRANTED;
  }, [addLog, requestCameraPermission]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    requestCameraPermission('preview startup')
      .catch(error => {
        setCameraPermissionGranted(false);
        setCameraPermissionStatus('unavailable');
        addLog('error', `Camera permission request failed: ${String(error)}`);
      });
  }, [addLog, requestCameraPermission]);

  const stopNativeStreams = useCallback(async () => {
    try {
      await GeminiAudioBridge.stopRecording();
      await GeminiAudioBridge.stopPlayback();
    } catch (error) {
      addLog('warn', `Native stream stop warning: ${String(error)}`);
    }
  }, [addLog]);

  const stopCall = useCallback(async () => {
    activeRef.current = false;
    setupDoneRef.current = false;
    setCallActive(false);
    setSetupComplete(false);
    setStatus('idle');
    sendJson(buildAudioStreamEndMessage());
    await stopNativeStreams();
    wsRef.current?.close();
    wsRef.current = null;
    addLog('info', 'Call stopped');
  }, [addLog, sendJson, stopNativeStreams]);

  const connect = useCallback(
    (shape: SetupShape) => {
      setupShapeRef.current = shape;
      setupDoneRef.current = false;
      setSetupComplete(false);
      setStatus(`connecting (${shape})`);

      const socket = new WebSocket(buildGeminiWsUrl());
      wsRef.current = socket;

      socket.onopen = () => {
        addLog('info', `WebSocket open; sending ${shape} setup`);
        socket.send(
          JSON.stringify(
            buildSetupMessage(settings, shape, sessionHandleRef.current),
          ),
        );
      };

      socket.onerror = event => {
        addLog('error', `WebSocket error: ${JSON.stringify(event)}`);
      };

      socket.onclose = event => {
        addLog('warn', `WebSocket closed ${event.code}: ${event.reason || 'no reason'}`);
        const shouldRetrySetup =
          activeRef.current &&
          !setupDoneRef.current &&
          shape === 'setup' &&
          !retryingSetupRef.current;

        if (shouldRetrySetup) {
          retryingSetupRef.current = true;
          metricsRef.current.markReconnect();
          refreshMetrics();
          addLog('warn', 'Retrying setup with raw guide config envelope');
          connect('config');
          return;
        }

        if (activeRef.current) {
          activeRef.current = false;
          setupDoneRef.current = false;
          setStatus('closed');
          setCallActive(false);
          setSetupComplete(false);
          stopNativeStreams();
        }
      };

      socket.onmessage = async event => {
        metricsRef.current.markMessageReceived();
        refreshMetrics();

        let message: any;
        try {
          message = await parseWsPayload(event.data);
        } catch (error) {
          addLog(
            'warn',
            `Non-JSON server message: ${String(error)}; payload=${describeWsPayload(
              event.data,
            )}`,
          );
          return;
        }

        if (!setupDoneRef.current) {
          addLog('debug', `Server setup frame: ${describeWsPayload(message)}`);
        }

        if (message.setupComplete) {
          setupDoneRef.current = true;
          retryingSetupRef.current = false;
          setSetupComplete(true);
          setStatus('live');
          addLog('info', 'Gemini setup complete');
          try {
            await GeminiAudioBridge.startPlayback(AUDIO_OUTPUT_RATE);
            if (micOnRef.current) {
              await GeminiAudioBridge.startRecording(
                AUDIO_INPUT_RATE,
                settings.audioChunkMs,
              );
            }
          } catch (error) {
            addLog('error', `Audio start failed: ${String(error)}`);
          }
        }

        if (message.usageMetadata) {
          metricsRef.current.markUsage(message.usageMetadata);
          refreshMetrics();
        }

        if (message.goAway?.timeLeft) {
          addLog('warn', `Gemini goAway received; time left ${JSON.stringify(message.goAway.timeLeft)}`);
        }

        if (message.sessionResumptionUpdate) {
          const update = message.sessionResumptionUpdate;
          if (update.resumable && update.newHandle) {
            sessionHandleRef.current = update.newHandle;
            setSessionHandle(update.newHandle);
          }
        }

        const serverContent = message.serverContent;
        if (!serverContent) {
          return;
        }

        if (serverContent.inputTranscription?.text) {
          setInputTranscript(serverContent.inputTranscription.text);
        }
        if (serverContent.outputTranscription?.text) {
          setOutputTranscript(current =>
            `${current}${serverContent.outputTranscription.text}`,
          );
        }
        if (serverContent.interrupted) {
          addLog('info', 'Gemini response interrupted; clearing playback queue');
          await GeminiAudioBridge.clearPlaybackQueue();
        }
        if (serverContent.generationComplete) {
          addLog('debug', 'Generation complete');
        }
        if (serverContent.turnComplete) {
          addLog('debug', 'Turn complete');
        }

        const parts = serverContent.modelTurn?.parts ?? [];
        for (const part of parts) {
          const inlineData = part.inlineData;
          if (!inlineData?.data) {
            continue;
          }
          const bytes = Math.floor((inlineData.data.length * 3) / 4);
          metricsRef.current.markAudioReceived(bytes);
          if (speakerOnRef.current) {
            const depth = await GeminiAudioBridge.enqueuePlaybackChunk(
              inlineData.data,
            );
            metricsRef.current.markPlaybackQueueDepth(depth);
          }
          refreshMetrics();
        }
      };
    },
    [addLog, refreshMetrics, settings, stopNativeStreams],
  );

  const startCall = useCallback(async () => {
    if (!apiKeyReady) {
      addLog('error', 'Set GEMINI_API_KEY in src/config/geminiConfig.ts first');
      return;
    }
    const granted = await requestPermissions();
    if (!granted) {
      addLog('error', 'Camera and microphone permissions are required');
      return;
    }

    metricsRef.current.reset();
    waitingForSetupFrameLoggedRef.current = false;
    refreshMetrics();
    setInputTranscript('');
    setOutputTranscript('');
    activeRef.current = true;
    closedSocketFrameLoggedRef.current = false;
    retryingSetupRef.current = false;
    setCallActive(true);
    connect('setup');
  }, [addLog, apiKeyReady, connect, refreshMetrics, requestPermissions]);

  useEffect(() => {
    speakerOnRef.current = speakerOn;
  }, [speakerOn]);

  useEffect(() => {
    micOnRef.current = micOn;
    if (!callActive || !setupComplete) {
      return;
    }
    if (micOn) {
      GeminiAudioBridge.startRecording(AUDIO_INPUT_RATE, settings.audioChunkMs).catch(
        error => addLog('error', `Mic start failed: ${String(error)}`),
      );
    } else {
      GeminiAudioBridge.stopRecording()
        .then(() => sendJson(buildAudioStreamEndMessage()))
        .catch(error => addLog('warn', `Mic stop failed: ${String(error)}`));
    }
  }, [addLog, callActive, micOn, sendJson, settings.audioChunkMs, setupComplete]);

  useEffect(() => {
    if (cameraOn && !cameraPermissionGranted) {
      requestCameraPermission('camera toggle').catch(error => {
        addLog('error', `Camera permission request failed: ${String(error)}`);
      });
    }
  }, [
    addLog,
    cameraOn,
    cameraPermissionGranted,
    requestCameraPermission,
  ]);

  useEffect(() => {
    addLog(
      cameraPermissionGranted ? 'info' : 'warn',
      cameraPermissionGranted
        ? 'Camera preview enabled; preview stays on outside calls'
      : `Camera preview disabled; permission state=${cameraPermissionStatus}`,
    );
  }, [addLog, cameraPermissionGranted, cameraPermissionStatus]);

  useEffect(() => {
    if (!cameraPermissionGranted) {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      GeminiAudioBridge.startCameraCapture(
        settings.videoFps,
        settings.jpegQuality,
        settings.frameWidth,
        settings.frameHeight,
        'front',
      )
        .then(() => {
          if (!cancelled) {
            addLog(
              'info',
              `Native camera capture requested: ${settings.frameWidth}x${settings.frameHeight} @ ${settings.videoFps} fps`,
            );
          }
        })
        .catch(error => {
          addLog(
            'error',
            `Native camera capture start failed: ${String(error)}`,
          );
        });
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    addLog,
    cameraPermissionGranted,
    settings.frameHeight,
    settings.frameWidth,
    settings.jpegQuality,
    settings.videoFps,
  ]);

  useEffect(() => {
    return () => {
      GeminiAudioBridge.stopCameraCapture().catch(error => {
        addLog('warn', `Native camera capture stop failed: ${String(error)}`);
      });
    };
  }, [addLog]);

  useEffect(() => {
    const audioSub = geminiNativeEvents.addListener(
      'GeminiAudioChunk',
      (chunk: NativeAudioChunk) => {
        if (!activeRef.current || !setupDoneRef.current || !micOnRef.current) {
          return;
        }
        if (sendJson(buildAudioInputMessage(chunk))) {
          metricsRef.current.markAudioSent(chunk);
          refreshMetrics();
        }
      },
    );

    const videoSub = geminiNativeEvents.addListener(
      'GeminiVideoFrame',
      (frame: NativeVideoFrame) => {
        if (!firstCameraFrameLoggedRef.current) {
          firstCameraFrameLoggedRef.current = true;
          addLog(
            'info',
            `Camera pipeline receiving frames: ${frame.width}x${frame.height}, ${frame.bytes} bytes, q=${frame.quality}`,
          );
        }
        setLatestCameraFrameUri(`data:image/jpeg;base64,${frame.data}`);

        if (!cameraOn) {
          if (frame.frameId === 1 || frame.frameId % 30 === 0) {
            addLog(
              'debug',
              `Camera frame captured for preview only; sending disabled by Camera toggle. Latest frame #${frame.frameId}`,
            );
          }
          return;
        }

        if (!activeRef.current) {
          if (frame.frameId === 1 || frame.frameId % 30 === 0) {
            addLog(
              'debug',
              `Camera frame captured for preview only; no active call. Latest frame #${frame.frameId}`,
            );
          }
          return;
        }

        if (!setupDoneRef.current) {
          if (!waitingForSetupFrameLoggedRef.current) {
            waitingForSetupFrameLoggedRef.current = true;
            addLog(
              'warn',
              `Camera frames captured but not sent yet; waiting for Gemini setup. Latest frame #${frame.frameId}`,
            );
          }
          metricsRef.current.markFrameDropped();
          refreshMetrics();
          return;
        }

        if (sendJson(buildVideoInputMessage(frame))) {
          metricsRef.current.markVideoSent(frame);
          if (frame.frameId === 1 || frame.frameId % 30 === 0) {
            addLog(
              'debug',
              `Video frame sent to Gemini #${frame.frameId}: ${frame.width}x${frame.height}, ${frame.bytes} bytes`,
            );
          }
        } else {
          metricsRef.current.markFrameDropped();
          if (!closedSocketFrameLoggedRef.current) {
            closedSocketFrameLoggedRef.current = true;
            addLog(
              'warn',
              `Video sending stopped; WebSocket not open for frame #${frame.frameId}`,
            );
          }
        }
        refreshMetrics();
      },
    );

    const errorSub = geminiNativeEvents.addListener(
      'GeminiNativeError',
      (event: {source: string; message: string}) => {
        addLog('error', `${event.source}: ${event.message}`);
      },
    );

    const infoSub = geminiNativeEvents.addListener(
      'GeminiNativeInfo',
      (event: {source: string; message: string}) => {
        addLog('debug', `${event.source}: ${event.message}`);
      },
    );

    return () => {
      audioSub.remove();
      videoSub.remove();
      errorSub.remove();
      infoSub.remove();
      stopNativeStreams();
      wsRef.current?.close();
    };
  }, [addLog, cameraOn, refreshMetrics, sendJson, stopNativeStreams]);

  const canChangeSetup = !callActive;

  const metricRows = useMemo(
    () => [
      ['Status', status],
      ['Setup envelope', setupShapeRef.current],
      ['Session handle', sessionHandle ? 'available' : 'none'],
      ['Frames sent / dropped', `${metrics.framesSent} / ${metrics.framesDropped}`],
      ['Actual / target FPS', `${metrics.actualFps} / ${metrics.targetFps}`],
      ['Last frame', `${metrics.lastFrameSize}, ${metrics.lastFrameBytes} bytes`],
      ['JPEG quality', String(metrics.jpegQuality)],
      ['Video bytes sent', String(metrics.videoBytesSent)],
      ['Audio chunks sent', String(metrics.audioChunksSent)],
      ['Audio bytes sent', String(metrics.audioBytesSent)],
      ['Audio chunks received', String(metrics.audioChunksReceived)],
      ['Audio bytes received', String(metrics.audioBytesReceived)],
      ['Playback queue', String(metrics.playbackQueuedChunks)],
      ['Last latency marker', `${metrics.lastLatencyMs} ms`],
      ['Reconnects', String(metrics.reconnects)],
      ['Server messages', String(metrics.messagesReceived)],
      ['Prompt / response / total tokens', `${metrics.promptTokens} / ${metrics.responseTokens} / ${metrics.totalTokens}`],
    ],
    [metrics, sessionHandle, status],
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Gemini Live Video Call Test</Text>
          <Text style={styles.subtitle}>Android bare React Native · direct Live API WebSocket</Text>
        </View>

        <View style={styles.previewShell}>
          {latestCameraFrameUri ? (
            <Image
              source={{uri: latestCameraFrameUri}}
              style={styles.preview}
              resizeMode="cover"
            />
          ) : (
            <View style={[styles.preview, styles.previewEmpty]}>
              <Text style={styles.previewEmptyText}>
                Waiting for native camera frame
              </Text>
            </View>
          )}
          <View style={styles.previewBadge}>
            <Text style={styles.previewBadgeText}>{status}</Text>
          </View>
        </View>

        <View style={styles.controls}>
          <ActionButton
            label={callActive ? 'End call' : 'Start call'}
            tone={callActive ? 'danger' : 'primary'}
            onPress={callActive ? stopCall : startCall}
          />
          <Toggle label="Mic" value={micOn} onValueChange={setMicOn} />
          <Toggle label="Camera" value={cameraOn} onValueChange={setCameraOn} />
          <Toggle label="Speaker" value={speakerOn} onValueChange={setSpeakerOn} />
        </View>

        <Section title="Camera Pipeline">
          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Permission</Text>
            <Text style={styles.metricValue}>{cameraPermissionStatus}</Text>
          </View>
          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Preview enabled</Text>
            <Text style={styles.metricValue}>
              {cameraPermissionGranted ? 'yes' : 'no'}
            </Text>
          </View>
          <View style={styles.controls}>
            <ActionButton
              label="Request camera permission"
              tone="secondary"
              onPress={() => {
                requestCameraPermission('manual button').catch(error => {
                  addLog(
                    'error',
                    `Camera permission request failed: ${String(error)}`,
                  );
                });
              }}
            />
            <ActionButton
              label="Open app settings"
              tone="secondary"
              onPress={() => {
                Linking.openSettings().catch(error => {
                  addLog('error', `Open settings failed: ${String(error)}`);
                });
              }}
            />
          </View>
        </Section>

        <Section title="Master Prompt">
          {!canChangeSetup && (
            <Text style={styles.hint}>Stop the call before editing the master prompt.</Text>
          )}
          <TextInput
            editable={canChangeSetup}
            multiline
            value={settings.systemInstruction}
            onChangeText={value => updateSetting('systemInstruction', value)}
            placeholder="Enter the system instruction sent to Gemini at call setup"
            placeholderTextColor="#6f7a89"
            style={[styles.masterPrompt, !canChangeSetup && styles.disabled]}
          />
          <View style={styles.promptActions}>
            <Text style={styles.promptCount}>
              {settings.systemInstruction.trim().length} chars
            </Text>
            <View style={styles.promptButtons}>
              <ActionButton
                label="Reset"
                tone="secondary"
                disabled={!canChangeSetup}
                onPress={() =>
                  updateSetting(
                    'systemInstruction',
                    DEFAULT_LIVE_SETTINGS.systemInstruction,
                  )
                }
              />
              <ActionButton
                label="Clear"
                tone="secondary"
                disabled={!canChangeSetup}
                onPress={() => updateSetting('systemInstruction', '')}
              />
            </View>
          </View>
        </Section>

        <Section title="Live API Settings">
          {!canChangeSetup && (
            <Text style={styles.hint}>Stop the call before changing setup-level settings.</Text>
          )}
          <NumberField label="Video FPS" value={settings.videoFps} min={0.2} max={8} step={0.5} disabled={!canChangeSetup} onChange={value => updateSetting('videoFps', value)} />
          <NumberField label="Frame width" value={settings.frameWidth} min={160} max={1280} step={80} disabled={!canChangeSetup} onChange={value => updateSetting('frameWidth', value)} />
          <NumberField label="Frame height" value={settings.frameHeight} min={120} max={960} step={60} disabled={!canChangeSetup} onChange={value => updateSetting('frameHeight', value)} />
          <NumberField label="JPEG quality" value={settings.jpegQuality} min={25} max={95} step={5} disabled={!canChangeSetup} onChange={value => updateSetting('jpegQuality', value)} />
          <OptionRow<MediaResolution> label="Media resolution" value={settings.mediaResolution} disabled={!canChangeSetup} options={['MEDIA_RESOLUTION_LOW', 'MEDIA_RESOLUTION_MEDIUM', 'MEDIA_RESOLUTION_HIGH']} onChange={value => updateSetting('mediaResolution', value)} />
          <NumberField label="Temperature" value={settings.temperature} min={0} max={2} step={0.1} disabled={!canChangeSetup} onChange={value => updateSetting('temperature', value)} />
          <NumberField label="Top P" value={settings.topP} min={0.1} max={1} step={0.05} disabled={!canChangeSetup} onChange={value => updateSetting('topP', value)} />
          <NumberField label="Top K" value={settings.topK} min={1} max={64} step={1} disabled={!canChangeSetup} onChange={value => updateSetting('topK', value)} />
          <OptionRow<SpeechLanguageCode> label="Speech language" value={settings.speechLanguageCode} disabled={!canChangeSetup} options={['en-US', 'en-IN', 'en-GB', 'en-AU']} onChange={value => updateSetting('speechLanguageCode', value)} />
          <Toggle label="Input transcription" value={settings.inputTranscription} disabled={!canChangeSetup} onValueChange={value => updateSetting('inputTranscription', value)} />
          <Toggle label="Output transcription" value={settings.outputTranscription} disabled={!canChangeSetup} onValueChange={value => updateSetting('outputTranscription', value)} />
          <Toggle label="Session resumption" value={settings.sessionResumption} disabled={!canChangeSetup} onValueChange={value => updateSetting('sessionResumption', value)} />
          <Toggle label="Context compression" value={settings.contextCompression} disabled={!canChangeSetup} onValueChange={value => updateSetting('contextCompression', value)} />
          <NumberField label="Context trigger tokens" value={settings.contextTriggerTokens} min={4000} max={64000} step={1000} disabled={!canChangeSetup || !settings.contextCompression} onChange={value => updateSetting('contextTriggerTokens', value)} />
          <NumberField label="Audio chunk ms" value={settings.audioChunkMs} min={20} max={100} step={10} disabled={!canChangeSetup} onChange={value => updateSetting('audioChunkMs', value)} />
          <OptionRow<StartSensitivity> label="Start sensitivity" value={settings.startSensitivity} disabled={!canChangeSetup} options={['START_SENSITIVITY_HIGH', 'START_SENSITIVITY_LOW']} onChange={value => updateSetting('startSensitivity', value)} />
          <OptionRow<EndSensitivity> label="End sensitivity" value={settings.endSensitivity} disabled={!canChangeSetup} options={['END_SENSITIVITY_HIGH', 'END_SENSITIVITY_LOW']} onChange={value => updateSetting('endSensitivity', value)} />
          <NumberField label="Prefix padding ms" value={settings.prefixPaddingMs} min={0} max={1000} step={50} disabled={!canChangeSetup} onChange={value => updateSetting('prefixPaddingMs', value)} />
          <NumberField label="Silence duration ms" value={settings.silenceDurationMs} min={100} max={2500} step={50} disabled={!canChangeSetup} onChange={value => updateSetting('silenceDurationMs', value)} />
          <OptionRow<ActivityHandling> label="Activity handling" value={settings.activityHandling} disabled={!canChangeSetup} options={['START_OF_ACTIVITY_INTERRUPTS', 'NO_INTERRUPTION']} onChange={value => updateSetting('activityHandling', value)} />
          <OptionRow<TurnCoverage> label="Turn coverage" value={settings.turnCoverage} disabled={!canChangeSetup} options={['TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO', 'TURN_INCLUDES_ONLY_ACTIVITY', 'TURN_INCLUDES_ALL_INPUT']} onChange={value => updateSetting('turnCoverage', value)} />
        </Section>

        <Section title="Metrics">
          {metricRows.map(([label, value]) => (
            <View style={styles.metricRow} key={label}>
              <Text style={styles.metricLabel}>{label}</Text>
              <Text style={styles.metricValue}>{value}</Text>
            </View>
          ))}
        </Section>

        <Section title="Transcripts">
          <Text style={styles.transcriptLabel}>Input</Text>
          <Text style={styles.transcript}>{inputTranscript || 'No input transcript yet'}</Text>
          <Text style={styles.transcriptLabel}>Gemini</Text>
          <Text style={styles.transcript}>{outputTranscript || 'No output transcript yet'}</Text>
        </Section>

        <Section title="Logs">
          <ActionButton label="Clear logs" tone="secondary" onPress={() => setLogs([])} />
          {logs.map(log => (
            <Text key={log.id} style={[styles.logLine, styles[`log_${log.level}`]]}>
              {log.at} [{log.level}] {log.message}
            </Text>
          ))}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  tone,
  disabled,
}: {
  label: string;
  onPress: () => void;
  tone: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      style={[
        styles.button,
        styles[`button_${tone}`],
        disabled && styles.disabled,
      ]}
      onPress={onPress}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function Toggle({
  label,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.toggleRow, disabled && styles.disabled]}>
      <Text style={styles.label}>{label}</Text>
      <Switch value={value} disabled={disabled} onValueChange={onValueChange} />
    </View>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const set = (next: number) => {
    onChange(Number(Math.min(max, Math.max(min, next)).toFixed(2)));
  };

  return (
    <View style={[styles.numberRow, disabled && styles.disabled]}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable disabled={disabled} style={styles.stepButton} onPress={() => set(value - step)}>
          <Text style={styles.stepText}>-</Text>
        </Pressable>
        <Text style={styles.numberValue}>{value}</Text>
        <Pressable disabled={disabled} style={styles.stepButton} onPress={() => set(value + step)}>
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function OptionRow<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: T[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.optionBlock, disabled && styles.disabled]}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.optionWrap}>
        {options.map(option => (
          <Pressable
            disabled={disabled}
            key={option}
            onPress={() => onChange(option)}
            style={[styles.option, option === value && styles.optionSelected]}>
            <Text style={[styles.optionText, option === value && styles.optionTextSelected]}>
              {option.replace(/_/g, ' ')}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#111318',
  },
  content: {
    padding: 16,
    gap: 14,
  },
  header: {
    gap: 4,
  },
  title: {
    color: '#f4f7fb',
    fontSize: 24,
    fontWeight: '700',
  },
  subtitle: {
    color: '#aab4c0',
    fontSize: 13,
  },
  previewShell: {
    height: 280,
    overflow: 'hidden',
    borderRadius: 8,
    backgroundColor: '#20242d',
    borderWidth: 1,
    borderColor: '#343b49',
  },
  preview: {
    flex: 1,
  },
  previewEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewEmptyText: {
    color: '#aab4c0',
    fontSize: 13,
  },
  previewBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  previewBadgeText: {
    color: '#ffffff',
    fontSize: 12,
  },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    alignItems: 'center',
  },
  section: {
    gap: 10,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#181c23',
    borderWidth: 1,
    borderColor: '#2f3541',
  },
  sectionTitle: {
    color: '#f4f7fb',
    fontSize: 17,
    fontWeight: '700',
  },
  hint: {
    color: '#f4c67a',
    fontSize: 12,
  },
  button: {
    minHeight: 40,
    justifyContent: 'center',
    borderRadius: 6,
    paddingHorizontal: 14,
  },
  button_primary: {
    backgroundColor: '#2f7cf6',
  },
  button_secondary: {
    backgroundColor: '#374151',
  },
  button_danger: {
    backgroundColor: '#c2413b',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  toggleRow: {
    minHeight: 42,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  numberRow: {
    minHeight: 42,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  label: {
    flex: 1,
    color: '#d7dee8',
    fontSize: 14,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stepButton: {
    width: 36,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: '#2b3240',
  },
  stepText: {
    color: '#ffffff',
    fontSize: 20,
  },
  numberValue: {
    minWidth: 54,
    color: '#ffffff',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  optionBlock: {
    gap: 8,
  },
  optionWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  option: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#242b36',
    borderWidth: 1,
    borderColor: '#333b49',
  },
  optionSelected: {
    backgroundColor: '#1b4f9c',
    borderColor: '#5d9bf8',
  },
  optionText: {
    color: '#cbd5e1',
    fontSize: 11,
  },
  optionTextSelected: {
    color: '#ffffff',
    fontWeight: '700',
  },
  masterPrompt: {
    minHeight: 150,
    borderRadius: 6,
    padding: 12,
    color: '#ffffff',
    backgroundColor: '#10141b',
    borderWidth: 1,
    borderColor: '#313846',
    textAlignVertical: 'top',
    lineHeight: 20,
  },
  promptActions: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  promptCount: {
    color: '#aab4c0',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  promptButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#343b49',
    paddingBottom: 6,
  },
  metricLabel: {
    flex: 1,
    color: '#aab4c0',
    fontSize: 12,
  },
  metricValue: {
    flex: 1,
    color: '#ffffff',
    textAlign: 'right',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  transcriptLabel: {
    color: '#f4f7fb',
    fontWeight: '700',
  },
  transcript: {
    color: '#cbd5e1',
    lineHeight: 20,
  },
  logLine: {
    color: '#cbd5e1',
    fontSize: 11,
    lineHeight: 16,
  },
  log_info: {
    color: '#d7dee8',
  },
  log_warn: {
    color: '#f4c67a',
  },
  log_error: {
    color: '#ff8d88',
  },
  log_debug: {
    color: '#9ab8ff',
  },
  disabled: {
    opacity: 0.48,
  },
});

export default App;
