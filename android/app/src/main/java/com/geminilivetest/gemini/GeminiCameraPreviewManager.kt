package com.geminilivetest.gemini

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

class GeminiCameraPreviewManager(private val appContext: ReactApplicationContext) :
    SimpleViewManager<GeminiCameraPreviewView>() {

  override fun getName(): String = "GeminiCameraPreview"

  override fun createViewInstance(reactContext: ThemedReactContext): GeminiCameraPreviewView =
      GeminiCameraPreviewView(reactContext, appContext)

  @ReactProp(name = "enabled", defaultBoolean = false)
  fun setStreamingEnabled(view: GeminiCameraPreviewView, enabled: Boolean) {
    view.setStreamingEnabled(enabled)
  }

  @ReactProp(name = "fps", defaultFloat = 2f)
  fun setFps(view: GeminiCameraPreviewView, fps: Float) {
    view.setTargetFps(fps.toDouble())
  }

  @ReactProp(name = "jpegQuality", defaultInt = 65)
  fun setJpegQuality(view: GeminiCameraPreviewView, jpegQuality: Int) {
    view.setJpegQuality(jpegQuality)
  }

  @ReactProp(name = "targetWidth", defaultInt = 640)
  fun setTargetWidth(view: GeminiCameraPreviewView, width: Int) {
    view.setTargetWidth(width)
  }

  @ReactProp(name = "targetHeight", defaultInt = 480)
  fun setTargetHeight(view: GeminiCameraPreviewView, height: Int) {
    view.setTargetHeight(height)
  }

  @ReactProp(name = "cameraFacing")
  fun setCameraFacing(view: GeminiCameraPreviewView, facing: String?) {
    view.setCameraFacing(facing ?: "front")
  }
}
