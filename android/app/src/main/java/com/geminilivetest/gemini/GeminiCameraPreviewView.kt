package com.geminilivetest.gemini

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.util.Base64
import android.util.Size
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ThemedReactContext
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

class GeminiCameraPreviewView(
    private val themedContext: ThemedReactContext,
    private val appContext: ReactApplicationContext
) : FrameLayout(themedContext) {

  private val previewView =
      PreviewView(themedContext).apply {
        layoutParams =
            LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        scaleType = PreviewView.ScaleType.FILL_CENTER
        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
      }
  private var analyzerExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private var cameraProvider: ProcessCameraProvider? = null
  private var streamingEnabled = false
  private var targetFps = 2.0
  private var jpegQuality = 65
  private var targetWidth = 640
  private var targetHeight = 480
  private var cameraFacing = "front"
  private var lastFrameNs = 0L
  private var frameId = 0
  private var firstFrameLogged = false

  init {
    addView(previewView)
    setBackgroundColor(android.graphics.Color.BLACK)
  }

  fun setStreamingEnabled(enabled: Boolean) {
    if (streamingEnabled == enabled) {
      return
    }
    streamingEnabled = enabled
    if (enabled) bindCamera() else unbindCamera()
  }

  fun setTargetFps(fps: Double) {
    targetFps = fps.coerceIn(0.2, 12.0)
  }

  fun setJpegQuality(quality: Int) {
    jpegQuality = quality.coerceIn(25, 95)
  }

  fun setTargetWidth(width: Int) {
    val coerced = width.coerceIn(160, 1920)
    if (targetWidth != coerced) {
      targetWidth = coerced
      rebindIfStreaming()
    }
  }

  fun setTargetHeight(height: Int) {
    val coerced = height.coerceIn(120, 1080)
    if (targetHeight != coerced) {
      targetHeight = coerced
      rebindIfStreaming()
    }
  }

  fun setCameraFacing(facing: String) {
    val normalized = if (facing == "back") "back" else "front"
    if (cameraFacing != normalized) {
      cameraFacing = normalized
      rebindIfStreaming()
    }
  }

  private fun rebindIfStreaming() {
    if (streamingEnabled) {
      bindCamera()
    }
  }

  @Suppress("DEPRECATION")
  private fun bindCamera() {
    emitInfo("camera", "Binding camera preview")
    ensureAnalyzerExecutor()
    if (ContextCompat.checkSelfPermission(themedContext, Manifest.permission.CAMERA) !=
        PackageManager.PERMISSION_GRANTED) {
      streamingEnabled = false
      emitError("camera", "CAMERA permission is not granted")
      return
    }

    val lifecycleOwner = themedContext.currentActivity as? LifecycleOwner
    if (lifecycleOwner == null) {
      emitError("camera", "Current activity is not a LifecycleOwner")
      return
    }

    val providerFuture = ProcessCameraProvider.getInstance(themedContext)
    providerFuture.addListener(
        {
          try {
            val provider = providerFuture.get()
            cameraProvider = provider
            provider.unbindAll()

            val preview =
                Preview.Builder()
                    .setTargetResolution(Size(targetWidth, targetHeight))
                    .build()
                    .also { it.setSurfaceProvider(previewView.surfaceProvider) }

            val analysis =
                ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setTargetResolution(Size(targetWidth, targetHeight))
                    .build()
                    .also { it.setAnalyzer(analyzerExecutor) { image -> analyzeFrame(image) } }

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
                    emitInfo("camera", "Requested ${cameraFacing} camera unavailable; using fallback camera")
                    fallbackSelector
                  }
                  else -> {
                    emitError("camera", "No usable camera found")
                    return@addListener
                  }
                }

            firstFrameLogged = false
            frameId = 0
            provider.bindToLifecycle(lifecycleOwner, selector, preview, analysis)
            emitInfo("camera", "Camera preview bound: ${cameraFacing} ${targetWidth}x${targetHeight}")
          } catch (error: Throwable) {
            emitError("camera", error.message ?: "Failed to bind camera")
          }
        },
        ContextCompat.getMainExecutor(themedContext))
  }

  private fun unbindCamera() {
    try {
      cameraProvider?.unbindAll()
    } catch (_: Throwable) {}
    lastFrameNs = 0L
  }

  private fun analyzeFrame(image: ImageProxy) {
    try {
      if (!streamingEnabled) {
        return
      }
      val now = System.nanoTime()
      val minFrameInterval = (1_000_000_000.0 / max(0.2, targetFps)).toLong()
      if (lastFrameNs > 0 && now - lastFrameNs < minFrameInterval) {
        return
      }
      lastFrameNs = now

      val jpeg = imageProxyToJpeg(image, jpegQuality)
      frameId += 1
      val encoded = Base64.encodeToString(jpeg, Base64.NO_WRAP)
      if (!firstFrameLogged || frameId % 30 == 0) {
        firstFrameLogged = true
        emitInfo("camera", "Camera frame emitted #${frameId}: ${image.width}x${image.height}, ${jpeg.size} bytes, q=${jpegQuality}")
      }
      val event =
          Arguments.createMap().apply {
            putString("data", encoded)
            putString("mimeType", "image/jpeg")
            putInt("width", image.width)
            putInt("height", image.height)
            putInt("bytes", jpeg.size)
            putInt("quality", jpegQuality)
            putDouble("targetFps", targetFps)
            putDouble("timestamp", System.currentTimeMillis().toDouble())
            putInt("frameId", frameId)
          }
      emit("GeminiVideoFrame", event)
    } catch (error: Throwable) {
      emitError("camera", error.message ?: "Frame analysis failed")
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

  private fun emit(eventName: String, params: Any) {
    appContext
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

  private fun ensureAnalyzerExecutor() {
    if (analyzerExecutor.isShutdown || analyzerExecutor.isTerminated) {
      analyzerExecutor = Executors.newSingleThreadExecutor()
      emitInfo("camera", "Camera analyzer executor recreated")
    }
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    unbindCamera()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (streamingEnabled && cameraProvider == null) {
      bindCamera()
    }
  }
}
