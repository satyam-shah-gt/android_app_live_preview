package com.geminilivetest.gemini

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.util.Base64
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.max
import kotlin.math.min

class GeminiAudioBridgeModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val recording = AtomicBoolean(false)
  private val playbackQueueDepth = AtomicInteger(0)
  private var audioRecord: AudioRecord? = null
  private var audioTrack: AudioTrack? = null
  private var recordingThread: Thread? = null
  private var playbackExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private var cameraExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private var cameraProvider: ProcessCameraProvider? = null
  private var cameraTargetFps = 2.0
  private var cameraJpegQuality = 65
  private var lastCameraFrameNs = 0L
  private var cameraFrameId = 0
  private var firstCameraFrameLogged = false

  override fun getName(): String = "GeminiAudioBridge"

  @ReactMethod
  fun addListener(eventName: String) {
    // Required by NativeEventEmitter.
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // Required by NativeEventEmitter.
  }

  @ReactMethod
  fun startRecording(sampleRate: Int, chunkMs: Int, promise: Promise) {
    if (reactContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
        PackageManager.PERMISSION_GRANTED) {
      promise.reject("microphone_permission", "RECORD_AUDIO permission is not granted")
      return
    }

    stopRecordingInternal()

    val channel = AudioFormat.CHANNEL_IN_MONO
    val encoding = AudioFormat.ENCODING_PCM_16BIT
    val bytesPerSample = 2
    val requestedChunkBytes = max(320, sampleRate * bytesPerSample * max(20, chunkMs) / 1000)
    val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channel, encoding)
    val bufferSize = max(minBuffer, requestedChunkBytes * 2)

    audioRecord =
        AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            sampleRate,
            channel,
            encoding,
            bufferSize)

    val recorder = audioRecord
    if (recorder == null || recorder.state != AudioRecord.STATE_INITIALIZED) {
      promise.reject("audio_record_init", "AudioRecord failed to initialize")
      return
    }

    recording.set(true)
    recorder.startRecording()
    recordingThread =
        Thread {
              val buffer = ByteArray(requestedChunkBytes)
              while (recording.get()) {
                val read = recorder.read(buffer, 0, buffer.size)
                if (read > 0) {
                  val encoded = Base64.encodeToString(buffer.copyOf(read), Base64.NO_WRAP)
                  val event =
                      Arguments.createMap().apply {
                        putString("data", encoded)
                        putInt("bytes", read)
                        putInt("sampleRate", sampleRate)
                        putInt("chunkMs", chunkMs)
                        putDouble("timestamp", System.currentTimeMillis().toDouble())
                      }
                  emit("GeminiAudioChunk", event)
                }
              }
            }
            .apply {
              name = "GeminiAudioRecord"
              isDaemon = true
              start()
            }

    promise.resolve(null)
  }

  @ReactMethod
  fun stopRecording(promise: Promise) {
    stopRecordingInternal()
    promise.resolve(null)
  }

  @ReactMethod
  fun startCameraCapture(
      fps: Double,
      jpegQuality: Int,
      targetWidth: Int,
      targetHeight: Int,
      cameraFacing: String,
      promise: Promise
  ) {
    if (reactContext.checkSelfPermission(Manifest.permission.CAMERA) !=
        PackageManager.PERMISSION_GRANTED) {
      promise.reject("camera_permission", "CAMERA permission is not granted")
      return
    }

    val activity = reactContext.currentActivity
    val lifecycleOwner = activity as? LifecycleOwner
    if (lifecycleOwner == null) {
      promise.reject("camera_lifecycle", "Current activity is not a LifecycleOwner")
      return
    }

    cameraTargetFps = fps.coerceIn(0.2, 12.0)
    cameraJpegQuality = jpegQuality.coerceIn(25, 95)
    ensureCameraExecutor()

    val width = targetWidth.coerceIn(160, 1920)
    val height = targetHeight.coerceIn(120, 1080)
    val providerFuture = ProcessCameraProvider.getInstance(reactContext)
    emitInfo("camera", "Native camera capture binding ${cameraFacing} ${width}x${height} @ ${cameraTargetFps}fps")

    providerFuture.addListener(
        {
          try {
            val provider = providerFuture.get()
            cameraProvider = provider
            provider.unbindAll()

            val analysis =
                ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setTargetResolution(Size(width, height))
                    .build()
                    .also { it.setAnalyzer(cameraExecutor) { image -> analyzeCameraFrame(image) } }

            val requestedSelector =
                if (cameraFacing == "back") CameraSelector.DEFAULT_BACK_CAMERA
                else CameraSelector.DEFAULT_FRONT_CAMERA
            val fallbackSelector =
                if (cameraFacing == "back") CameraSelector.DEFAULT_FRONT_CAMERA
                else CameraSelector.DEFAULT_BACK_CAMERA
            val selector =
                when {
                  provider.hasCamera(requestedSelector) -> requestedSelector
                  provider.hasCamera(fallbackSelector) -> {
                    emitInfo("camera", "Requested ${cameraFacing} camera unavailable; using fallback")
                    fallbackSelector
                  }
                  else -> {
                    promise.reject("camera_unavailable", "No usable camera found")
                    return@addListener
                  }
                }

            firstCameraFrameLogged = false
            cameraFrameId = 0
            lastCameraFrameNs = 0L
            provider.bindToLifecycle(lifecycleOwner, selector, analysis)
            emitInfo("camera", "Native camera capture bound ${width}x${height}")
            promise.resolve(null)
          } catch (error: Throwable) {
            emitError("camera", error.message ?: "Native camera capture bind failed")
            promise.reject("camera_bind", error.message, error)
          }
        },
        ContextCompat.getMainExecutor(reactContext))
  }

  @ReactMethod
  fun stopCameraCapture(promise: Promise) {
    stopCameraCaptureInternal()
    promise.resolve(null)
  }

  @ReactMethod
  fun startPlayback(sampleRate: Int, promise: Promise) {
    stopPlaybackInternal()
    playbackExecutor = Executors.newSingleThreadExecutor()

    val channel = AudioFormat.CHANNEL_OUT_MONO
    val encoding = AudioFormat.ENCODING_PCM_16BIT
    val minBuffer = AudioTrack.getMinBufferSize(sampleRate, channel, encoding)
    audioTrack =
        AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build())
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(encoding)
                    .setSampleRate(sampleRate)
                    .setChannelMask(channel)
                    .build())
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(max(minBuffer, sampleRate))
            .build()

    val player = audioTrack
    if (player == null || player.state != AudioTrack.STATE_INITIALIZED) {
      promise.reject("audio_track_init", "AudioTrack failed to initialize")
      return
    }
    player.play()
    promise.resolve(null)
  }

  @ReactMethod
  fun enqueuePlaybackChunk(base64Pcm: String, promise: Promise) {
    val player = audioTrack
    if (player == null) {
      promise.resolve(0)
      return
    }
    val depth = playbackQueueDepth.incrementAndGet()
    playbackExecutor.execute {
      try {
        val bytes = Base64.decode(base64Pcm, Base64.DEFAULT)
        player.write(bytes, 0, bytes.size)
      } catch (error: Throwable) {
        emitError("playback", error.message ?: "Playback write failed")
      } finally {
        playbackQueueDepth.decrementAndGet()
      }
    }
    promise.resolve(depth)
  }

  @ReactMethod
  fun clearPlaybackQueue(promise: Promise) {
    audioTrack?.pause()
    audioTrack?.flush()
    audioTrack?.play()
    playbackQueueDepth.set(0)
    promise.resolve(null)
  }

  @ReactMethod
  fun stopPlayback(promise: Promise) {
    stopPlaybackInternal()
    promise.resolve(null)
  }

  private fun stopRecordingInternal() {
    recording.set(false)
    try {
      audioRecord?.stop()
    } catch (_: Throwable) {}
    audioRecord?.release()
    audioRecord = null
    recordingThread = null
  }

  private fun stopPlaybackInternal() {
    try {
      playbackExecutor.shutdownNow()
    } catch (_: Throwable) {}
    playbackQueueDepth.set(0)
    try {
      audioTrack?.stop()
    } catch (_: Throwable) {}
    audioTrack?.release()
    audioTrack = null
  }

  private fun stopCameraCaptureInternal() {
    try {
      cameraProvider?.unbindAll()
    } catch (_: Throwable) {}
    lastCameraFrameNs = 0L
  }

  private fun analyzeCameraFrame(image: ImageProxy) {
    try {
      val now = System.nanoTime()
      val minFrameInterval = (1_000_000_000.0 / max(0.2, cameraTargetFps)).toLong()
      if (lastCameraFrameNs > 0 && now - lastCameraFrameNs < minFrameInterval) {
        return
      }
      lastCameraFrameNs = now

      val jpeg = imageProxyToJpeg(image, cameraJpegQuality)
      cameraFrameId += 1
      if (!firstCameraFrameLogged || cameraFrameId % 30 == 0) {
        firstCameraFrameLogged = true
        emitInfo(
            "camera",
            "Native camera frame emitted #${cameraFrameId}: ${image.width}x${image.height}, ${jpeg.size} bytes, q=${cameraJpegQuality}")
      }
      val event =
          Arguments.createMap().apply {
            putString("data", Base64.encodeToString(jpeg, Base64.NO_WRAP))
            putString("mimeType", "image/jpeg")
            putInt("width", image.width)
            putInt("height", image.height)
            putInt("bytes", jpeg.size)
            putInt("quality", cameraJpegQuality)
            putDouble("targetFps", cameraTargetFps)
            putDouble("timestamp", System.currentTimeMillis().toDouble())
            putInt("frameId", cameraFrameId)
          }
      emit("GeminiVideoFrame", event)
    } catch (error: Throwable) {
      emitError("camera", error.message ?: "Native camera frame analysis failed")
    } finally {
      image.close()
    }
  }

  private fun imageProxyToJpeg(image: ImageProxy, quality: Int): ByteArray {
    val nv21 = yuv420ToNv21(image)
    val output = ByteArrayOutputStream()
    val yuvImage = YuvImage(nv21, ImageFormat.NV21, image.width, image.height, null)
    yuvImage.compressToJpeg(Rect(0, 0, image.width, image.height), quality, output)
    return output.toByteArray()
  }

  private fun yuv420ToNv21(image: ImageProxy): ByteArray {
    val width = image.width
    val height = image.height
    val ySize = width * height
    val uvSize = width * height / 2
    val nv21 = ByteArray(ySize + uvSize)

    val yPlane = image.planes[0]
    val uPlane = image.planes[1]
    val vPlane = image.planes[2]

    copyLuma(yPlane.buffer, nv21, width, height, yPlane.rowStride)

    val uBuffer = uPlane.buffer.duplicate()
    val vBuffer = vPlane.buffer.duplicate()
    var outputOffset = ySize
    val chromaHeight = height / 2
    val chromaWidth = width / 2

    for (row in 0 until chromaHeight) {
      val uRowStart = row * uPlane.rowStride
      val vRowStart = row * vPlane.rowStride
      for (col in 0 until chromaWidth) {
        val uIndex = min(uRowStart + col * uPlane.pixelStride, uBuffer.limit() - 1)
        val vIndex = min(vRowStart + col * vPlane.pixelStride, vBuffer.limit() - 1)
        nv21[outputOffset++] = vBuffer.get(vIndex)
        nv21[outputOffset++] = uBuffer.get(uIndex)
      }
    }
    return nv21
  }

  private fun copyLuma(buffer: ByteBuffer, output: ByteArray, width: Int, height: Int, rowStride: Int) {
    val yBuffer = buffer.duplicate()
    var outputOffset = 0
    val row = ByteArray(rowStride)
    for (rowIndex in 0 until height) {
      val length = min(rowStride, yBuffer.remaining())
      yBuffer.get(row, 0, length)
      System.arraycopy(row, 0, output, outputOffset, width)
      outputOffset += width
    }
  }

  private fun ensureCameraExecutor() {
    if (cameraExecutor.isShutdown || cameraExecutor.isTerminated) {
      cameraExecutor = Executors.newSingleThreadExecutor()
      emitInfo("camera", "Native camera analyzer executor recreated")
    }
  }

  private fun emit(eventName: String, params: Any) {
    reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(eventName, params)
  }

  private fun emitError(source: String, message: String) {
    val event =
        Arguments.createMap().apply {
          putString("source", source)
          putString("message", message)
        }
    emit("GeminiNativeError", event)
  }

  private fun emitInfo(source: String, message: String) {
    val event =
        Arguments.createMap().apply {
          putString("source", source)
          putString("message", message)
        }
    emit("GeminiNativeInfo", event)
  }
}
