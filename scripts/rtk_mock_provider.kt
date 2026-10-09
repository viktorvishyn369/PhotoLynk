package com.rtkmock

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import android.location.OnNmeaMessageListener
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.appcompat.app.AppCompatActivity

/**
 * Minimal Android app that acts as a mock location provider.
 *
 * Install on device, then enable it as the "Mock Location app" in
 * Developer Options → Select mock location app.
 *
 * The Python script (rtk_mock_gps.py) sends broadcasts to this app
 * via ADB over USB, which then injects RTK-grade locations into the
 * Android LocationManager.
 *
 * Manifest requirements:
 *   <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
 *   <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
 *   <uses-permission android:name="android.permission.ACCESS_MOCK_LOCATION" />
 *
 *   <receiver android:name=".MockReceiver" android:exported="true">
 *       <intent-filter>
 *           <action android:name="com.rtkmock.SET_LOCATION" />
 *           <action android:name="com.rtkmock.SET_NMEA" />
 *       </intent-filter>
 *   </receiver>
 */

class MockReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "RTKMock"
        private const val PROVIDER = LocationManager.GPS_PROVIDER
        private var nmeaCallback: OnNmeaMessageListener? = null
    }

    override fun onReceive(context: Context, intent: Intent) {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

        when (intent.action) {
            "com.rtkmock.SET_LOCATION" -> {
                val lat = intent.getDoubleExtra("lat", 0.0)
                val lon = intent.getDoubleExtra("lon", 0.0)
                val alt = intent.getDoubleExtra("alt", 0.0)
                val acc = intent.getFloatExtra("accuracy", 0.02f)   // 2cm = RTK
                val spd = intent.getFloatExtra("speed", 0.0f)
                val brg = intent.getFloatExtra("bearing", 0.0f)

                try {
                    // Ensure test provider exists
                    if (!lm.isProviderEnabled(PROVIDER)) {
                        lm.addTestProvider(
                            PROVIDER,
                            false,          // requiresNetwork
                            false,          // requiresSatellite
                            false,          // requiresCell
                            false,          // hasMonetaryCost
                            true,           // supportsAltitude
                            true,           // supportsSpeed
                            true,           // supportsBearing
                            android.location.Criteria.POWER_LOW,
                            android.location.Criteria.ACCURACY_FINE
                        )
                        lm.setTestProviderEnabled(PROVIDER, true)
                    }

                    val loc = Location(PROVIDER).apply {
                        latitude = lat
                        longitude = lon
                        altitude = alt
                        accuracy = acc          // 0.02m → RTK fixed quality
                        speed = spd
                        bearing = brg
                        time = System.currentTimeMillis()
                        elapsedRealtimeNanos = android.os.SystemClock.elapsedRealtimeNanos()

                        // Android 8.0+ vertical accuracy
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            verticalAccuracyMeters = acc
                            bearingAccuracyDegrees = 0.1f
                            speedAccuracyMetersPerSecond = 0.01f
                        }

                        // Extras to signal RTK quality to consuming apps
                        extras = Bundle().apply {
                            putInt("rtk_quality", 4)    // 4 = RTK fixed
                            putInt("satellites_used", 12)
                            putFloat("hdop", 0.5f)
                        }
                    }

                    lm.setTestProviderLocation(PROVIDER, loc)
                    Log.d(TAG, "Injected: lat=$lat lon=$lon alt=$alt acc=${acc}m (RTK)")
                } catch (e: SecurityException) {
                    Log.e(TAG, "Mock location not allowed. Enable in Developer Options.", e)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to inject location", e)
                }
            }

            "com.rtkmock.SET_NMEA" -> {
                val gga = intent.getStringExtra("gga") ?: return
                val rmc = intent.getStringExtra("rmc") ?: return

                // NMEA sentences can't be directly injected via LocationManager.
                // Apps using GnssStatus/NMEA listeners will receive the mock location
                // with RTK-quality accuracy. For full NMEA simulation, pipe these
                // sentences to a Bluetooth/USB serial emulator that the target app
                // reads from as an external GPS source.
                //
                // Alternatively, if the target app uses a USB serial NMEA reader,
                // you can send these sentences directly to the serial port.
                Log.d(TAG, "NMEA GGA: $gga")
                Log.d(TAG, "NMEA RMC: $rmc")
            }
        }
    }
}

/**
 * Optional: Activity to help users enable mock location and verify setup.
 */
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tv = android.widget.TextView(this).apply {
            text = """
                RTK Mock GPS Provider
                
                1. Enable Developer Options
                2. Go to: Developer Options → Select mock location app
                3. Select "RTK Mock GPS" from the list
                4. Run the Python script on your host:
                   python3 rtk_mock_gps.py --lat <lat> --lon <lon> --jitter
                
                The app will inject RTK-grade (2cm accuracy) locations
                with NMEA quality indicator 4 (RTK fixed).
            """.trimIndent()
            textSize = 16f
            setPadding(48, 96, 48, 96)
        }
        setContentView(tv)
    }
}
