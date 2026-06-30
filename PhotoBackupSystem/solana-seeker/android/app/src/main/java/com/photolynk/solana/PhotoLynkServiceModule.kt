package com.photolynk.solana

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * React Native bridge for the PhotoLynk foreground service.
 *
 * JS calls:
 *   NativeModules.PhotoLynkServiceModule.startService(title, body)
 *   NativeModules.PhotoLynkServiceModule.updateNotification(title, body)
 *   NativeModules.PhotoLynkServiceModule.stopService()
 */
class PhotoLynkServiceModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "PhotoLynkServiceModule"

    @ReactMethod
    fun startService(title: String, body: String) {
        PhotoLynkForegroundService.start(getReactApplicationContext(), title, body)
    }

    @ReactMethod
    fun updateNotification(title: String, body: String) {
        PhotoLynkForegroundService.update(getReactApplicationContext(), title, body)
    }

    @ReactMethod
    fun stopService() {
        PhotoLynkForegroundService.stop(getReactApplicationContext())
    }
}
