# Gemini Live Android Test App

Bare React Native Android app for testing a direct mobile connection to the Gemini Live API with camera frames, microphone PCM input, Gemini PCM audio output, runtime settings, and detailed metrics/logs.

The app connects directly:

```text
React Native Android app -> Gemini Live API WebSocket
```

This is a local test app. The Gemini API key is intentionally stored in app source for quick device testing.

## Requirements

- Linux/macOS/Windows shell with Node.js `>= 20.19.4`
- npm
- JDK 17
- Android Studio or Android SDK installed
- Android SDK packages:
  - Android platform/API 36
  - Build tools 36.x
  - Platform tools
  - CMake 3.22.1 or compatible React Native native build tooling
- Android emulator or physical Android device with camera and microphone
- Gemini API key from Google AI Studio

This repo was scaffolded with:

- React Native `0.85.3`
- React `19.2.3`
- Android compile/target SDK `36`
- Kotlin `2.1.20`

## Environment

Set Android SDK environment variables before building or running:

```sh
export ANDROID_HOME=/home/user/Android/Sdk
export ANDROID_SDK_ROOT=/home/user/Android/Sdk
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

If your SDK is in another location, replace `/home/user/Android/Sdk`.

You can verify the device connection with:

```sh
adb devices
```

## Gemini API Key

Edit:

```text
src/config/geminiConfig.ts
```

Replace:

```ts
export const GEMINI_API_KEY = 'PASTE_YOUR_GEMINI_API_KEY_HERE';
```

with your local test key.

The app uses:

```ts
export const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
```

## Install

Dependencies are already installed if this workspace was prepared by Codex. For a fresh clone or clean checkout:

```sh
npm install
```

## Run On Android

Start Metro:

```sh
npm start
```

In another terminal, with Android env variables set:

```sh
npm run android
```

For a direct Gradle debug APK build:

```sh
cd android
ANDROID_HOME=/home/user/Android/Sdk ANDROID_SDK_ROOT=/home/user/Android/Sdk ./gradlew assembleDebug
```

The debug APK is generated at:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## App Permissions

The app requests:

- `INTERNET`
- `CAMERA`
- `RECORD_AUDIO`

Grant camera and microphone permissions on first launch. The call will not start without both permissions.

## How To Test

1. Add the Gemini API key in `src/config/geminiConfig.ts`.
2. Start Metro with `npm start`.
3. Run the app on a device/emulator with `npm run android`.
4. Open the app and adjust Live API settings before starting the call.
5. Tap `Start call`.
6. Watch the logs and metrics panels for:
   - WebSocket setup state
   - sent FPS and actual FPS
   - frame size and JPEG bytes
   - audio chunks sent/received
   - Gemini audio playback queue depth
   - input/output transcripts
   - token usage metadata
   - reconnect/session resumption events

Settings are setup-level unless noted by the UI, so stop the call before changing Live API config.

## Verification Commands

Run TypeScript checks:

```sh
npm run typecheck
```

Run unit tests:

```sh
npm test -- --runInBand
```

Run Android build:

```sh
cd android
ANDROID_HOME=/home/user/Android/Sdk ANDROID_SDK_ROOT=/home/user/Android/Sdk ./gradlew assembleDebug
```

## Native Modules

Android native code lives under:

```text
android/app/src/main/java/com/geminilivetest/gemini/
```

Main pieces:

- `GeminiAudioBridgeModule.kt`: captures mic audio as 16kHz mono PCM16 chunks and plays Gemini output as 24kHz mono PCM16.
- `GeminiCameraPreviewView.kt`: renders CameraX preview and emits JPEG frames at configured FPS, size, and quality.
- `GeminiNativePackage.kt`: registers native audio and camera modules with React Native.

## Notes

- This app is Android-focused. iOS scaffold files exist from React Native CLI, but the Gemini camera/audio native bridge is implemented only for Android.
- The API key is bundled into the app. Do not use this approach for production.
- Gemini Live API is a realtime WebSocket API and may return preview-model or quota errors depending on account access, billing, region, and current model availability.
- If Gradle says `SDK location not found`, set `ANDROID_HOME`/`ANDROID_SDK_ROOT` or create `android/local.properties` with:

```properties
sdk.dir=/home/user/Android/Sdk
```
