package com.photolynk.solana

import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import androidx.exifinterface.media.ExifInterface
import com.facebook.react.bridge.*
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.text.SimpleDateFormat
import java.util.Locale

class ExifExtractorModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "ExifExtractor"

    @ReactMethod
    fun extractExif(path: String, promise: Promise) {
        Thread {
            try {
                val filePath = if (path.startsWith("file://")) path.removePrefix("file://") else path
                val isContentUri = path.startsWith("content://")
                
                val exif: ExifInterface? = if (isContentUri) {
                    val inputStream: InputStream? = reactApplicationContext.contentResolver.openInputStream(Uri.parse(path))
                    if (inputStream != null) {
                        ExifInterface(inputStream).also { inputStream.close() }
                    } else null
                } else {
                    val file = File(filePath)
                    if (file.exists()) ExifInterface(file) else null
                }
                
                if (exif == null) {
                    promise.reject("E_FILE", "Cannot open file: $path")
                    return@Thread
                }
                
                val result = Arguments.createMap()
                
                // Extract DateTimeOriginal (most reliable capture time)
                var captureTime: String? = null
                val dateTimeOriginal = exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)
                val dateTimeDigitized = exif.getAttribute(ExifInterface.TAG_DATETIME_DIGITIZED)
                val dateTime = exif.getAttribute(ExifInterface.TAG_DATETIME)
                
                val rawDateTime = dateTimeOriginal ?: dateTimeDigitized ?: dateTime
                if (rawDateTime != null) {
                    captureTime = normalizeExifDateTime(rawDateTime)
                }
                
                // Extract Make (manufacturer) - normalize to lowercase
                var make = exif.getAttribute(ExifInterface.TAG_MAKE)?.trim()?.lowercase(Locale.ROOT)
                
                // Extract Model - normalize to lowercase
                var model = exif.getAttribute(ExifInterface.TAG_MODEL)?.trim()?.lowercase(Locale.ROOT)
                
                // Fallback to device info for formats without EXIF (PNG screenshots, etc.)
                if (make.isNullOrEmpty()) {
                    make = Build.MANUFACTURER.lowercase(Locale.ROOT)
                }
                if (model.isNullOrEmpty()) {
                    model = Build.MODEL.lowercase(Locale.ROOT)
                }
                
                result.putString("captureTime", captureTime)
                result.putString("make", make)
                result.putString("model", model)
                
                // Timezone offset (EXIF 2.31+)
                exif.getAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL)?.let {
                    result.putString("offsetTimeOriginal", it.trim())
                }
                
                // Subsecond precision
                exif.getAttribute(ExifInterface.TAG_SUBSEC_TIME_ORIGINAL)?.let {
                    result.putString("subSecTimeOriginal", it)
                }
                
                // Camera settings
                exif.getAttribute(ExifInterface.TAG_EXPOSURE_TIME)?.let {
                    result.putDouble("exposureTime", it.toDoubleOrNull() ?: 0.0)
                }
                exif.getAttribute(ExifInterface.TAG_F_NUMBER)?.let {
                    result.putDouble("fNumber", it.toDoubleOrNull() ?: 0.0)
                }
                exif.getAttribute(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY)?.let {
                    result.putInt("iso", it.toIntOrNull() ?: 0)
                }
                exif.getAttribute(ExifInterface.TAG_FOCAL_LENGTH)?.let { fl ->
                    val parts = fl.split("/")
                    if (parts.size == 2) {
                        val num = parts[0].toDoubleOrNull() ?: 0.0
                        val den = parts[1].toDoubleOrNull() ?: 1.0
                        if (den != 0.0) {
                            result.putDouble("focalLength", num / den)
                        }
                    } else {
                        val parsed = fl.toDoubleOrNull()
                        if (parsed != null) {
                            result.putDouble("focalLength", parsed)
                        }
                    }
                }
                exif.getAttribute(ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM)?.let {
                    result.putInt("focalLengthIn35mm", it.toIntOrNull() ?: 0)
                }
                exif.getAttribute(ExifInterface.TAG_FLASH)?.let {
                    result.putInt("flash", it.toIntOrNull() ?: 0)
                }
                exif.getAttribute(ExifInterface.TAG_WHITE_BALANCE)?.let {
                    result.putInt("whiteBalance", it.toIntOrNull() ?: 0)
                }
                exif.getAttribute(ExifInterface.TAG_METERING_MODE)?.let {
                    result.putInt("meteringMode", it.toIntOrNull() ?: 0)
                }
                exif.getAttribute(ExifInterface.TAG_EXPOSURE_PROGRAM)?.let {
                    result.putInt("exposureProgram", it.toIntOrNull() ?: 0)
                }
                exif.getAttribute(ExifInterface.TAG_EXPOSURE_BIAS_VALUE)?.let { eb ->
                    val parts = eb.split("/")
                    if (parts.size == 2) {
                        val num = parts[0].toDoubleOrNull() ?: 0.0
                        val den = parts[1].toDoubleOrNull() ?: 1.0
                        if (den != 0.0) {
                            result.putDouble("exposureBias", num / den)
                        }
                    }
                }
                
                // Image properties
                exif.getAttribute(ExifInterface.TAG_IMAGE_WIDTH)?.let {
                    result.putInt("width", it.toIntOrNull() ?: 0)
                }
                exif.getAttribute(ExifInterface.TAG_IMAGE_LENGTH)?.let {
                    result.putInt("height", it.toIntOrNull() ?: 0)
                }
                exif.getAttribute(ExifInterface.TAG_ORIENTATION)?.let {
                    result.putInt("orientation", it.toIntOrNull() ?: 1)
                }
                exif.getAttribute(ExifInterface.TAG_COLOR_SPACE)?.let {
                    result.putInt("colorSpace", it.toIntOrNull() ?: 0)
                }
                
                // GPS data
                val latLong = exif.latLong
                if (latLong != null) {
                    result.putDouble("gpsLatitude", latLong[0])
                    result.putDouble("gpsLongitude", latLong[1])
                }
                val altitude = exif.getAltitude(Double.NaN)
                if (!altitude.isNaN()) {
                    result.putDouble("gpsAltitude", altitude)
                }
                exif.getAttribute(ExifInterface.TAG_GPS_DATESTAMP)?.let {
                    result.putString("gpsDateStamp", it)
                }
                exif.getAttribute(ExifInterface.TAG_GPS_TIMESTAMP)?.let {
                    result.putString("gpsTimestamp", it)
                }
                
                // Software/lens
                exif.getAttribute(ExifInterface.TAG_SOFTWARE)?.let {
                    result.putString("software", it.trim())
                }
                exif.getAttribute(ExifInterface.TAG_LENS_MAKE)?.let {
                    result.putString("lensMake", it.trim())
                }
                exif.getAttribute(ExifInterface.TAG_LENS_MODEL)?.let {
                    result.putString("lensModel", it.trim())
                }
                
                // IPTC-equivalent fields from EXIF tags
                exif.getAttribute(ExifInterface.TAG_IMAGE_DESCRIPTION)?.let {
                    result.putString("iptcCaption", it.trim())
                }
                exif.getAttribute(ExifInterface.TAG_COPYRIGHT)?.let {
                    result.putString("iptcCopyright", it.trim())
                }
                exif.getAttribute(ExifInterface.TAG_ARTIST)?.let {
                    result.putString("iptcCreator", it.trim())
                }
                
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("E_EXIF", "EXIF extraction failed: ${e.message}")
            }
        }.start()
    }
    
    private fun normalizeExifDateTime(exifDate: String): String? {
        val trimmed = exifDate.trim()
        if (trimmed.length < 19) return null
        
        val parts = trimmed.split(" ")
        if (parts.size < 2) return null
        
        val datePart = parts[0].replace(":", "-")
        val timePart = parts[1].take(8)
        
        return "${datePart}T${timePart}"
    }
    
    private fun isoToExifDateTime(isoDate: String): String? {
        val trimmed = isoDate.trim()
        if (trimmed.length < 19) return null
        
        val result = trimmed.take(19).replace("-", ":").replace("T", " ")
        return result
    }
    
    @ReactMethod
    fun writeExif(path: String, exifData: ReadableMap, promise: Promise) {
        Thread {
            try {
                val filePath = if (path.startsWith("file://")) path.removePrefix("file://") else path
                val file = File(filePath)
                
                if (!file.exists()) {
                    promise.reject("E_FILE", "File does not exist: $path")
                    return@Thread
                }
                
                val exif = ExifInterface(file)
                
                if (exifData.hasKey("captureTime")) {
                    val captureTime = exifData.getString("captureTime")
                    if (captureTime != null) {
                        val exifTime = isoToExifDateTime(captureTime)
                        if (exifTime != null) {
                            exif.setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL, exifTime)
                            exif.setAttribute(ExifInterface.TAG_DATETIME_DIGITIZED, exifTime)
                            exif.setAttribute(ExifInterface.TAG_DATETIME, exifTime)
                        }
                    }
                }
                
                if (exifData.hasKey("offsetTimeOriginal")) {
                    val offsetTime = exifData.getString("offsetTimeOriginal")
                    if (offsetTime != null) {
                        exif.setAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL, offsetTime)
                        exif.setAttribute(ExifInterface.TAG_OFFSET_TIME_DIGITIZED, offsetTime)
                        exif.setAttribute(ExifInterface.TAG_OFFSET_TIME, offsetTime)
                    }
                }
                
                if (exifData.hasKey("subSecTimeOriginal")) {
                    val subSecTime = exifData.getString("subSecTimeOriginal")
                    if (subSecTime != null) {
                        exif.setAttribute(ExifInterface.TAG_SUBSEC_TIME_ORIGINAL, subSecTime)
                        exif.setAttribute(ExifInterface.TAG_SUBSEC_TIME_DIGITIZED, subSecTime)
                        exif.setAttribute(ExifInterface.TAG_SUBSEC_TIME, subSecTime)
                    }
                }
                
                if (exifData.hasKey("make")) {
                    val make = exifData.getString("make")
                    if (make != null) {
                        exif.setAttribute(ExifInterface.TAG_MAKE, make)
                    }
                }
                
                if (exifData.hasKey("model")) {
                    val model = exifData.getString("model")
                    if (model != null) {
                        exif.setAttribute(ExifInterface.TAG_MODEL, model)
                    }
                }
                
                if (exifData.hasKey("exposureTime") && !exifData.isNull("exposureTime")) {
                    val exposureTime = exifData.getDouble("exposureTime")
                    exif.setAttribute(ExifInterface.TAG_EXPOSURE_TIME, exposureTime.toString())
                }
                
                if (exifData.hasKey("fNumber") && !exifData.isNull("fNumber")) {
                    val fNumber = exifData.getDouble("fNumber")
                    exif.setAttribute(ExifInterface.TAG_F_NUMBER, fNumber.toString())
                }
                
                if (exifData.hasKey("iso") && !exifData.isNull("iso")) {
                    val iso = exifData.getInt("iso")
                    exif.setAttribute(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY, iso.toString())
                }
                
                if (exifData.hasKey("focalLength") && !exifData.isNull("focalLength")) {
                    val focalLength = exifData.getDouble("focalLength")
                    val rational = "${(focalLength * 100).toInt()}/100"
                    exif.setAttribute(ExifInterface.TAG_FOCAL_LENGTH, rational)
                }
                
                if (exifData.hasKey("focalLengthIn35mm") && !exifData.isNull("focalLengthIn35mm")) {
                    val focalLengthIn35mm = exifData.getInt("focalLengthIn35mm")
                    exif.setAttribute(ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM, focalLengthIn35mm.toString())
                }
                
                if (exifData.hasKey("gpsLatitude") && !exifData.isNull("gpsLatitude") && exifData.hasKey("gpsLongitude") && !exifData.isNull("gpsLongitude")) {
                    val lat = exifData.getDouble("gpsLatitude")
                    val lon = exifData.getDouble("gpsLongitude")
                    exif.setLatLong(lat, lon)
                }
                
                if (exifData.hasKey("gpsAltitude") && !exifData.isNull("gpsAltitude")) {
                    val alt = exifData.getDouble("gpsAltitude")
                    exif.setAltitude(alt)
                }
                
                if (exifData.hasKey("software")) {
                    val software = exifData.getString("software")
                    if (software != null) {
                        exif.setAttribute(ExifInterface.TAG_SOFTWARE, software)
                    }
                }
                
                if (exifData.hasKey("orientation") && !exifData.isNull("orientation")) {
                    val orientation = exifData.getInt("orientation")
                    exif.setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString())
                }
                
                // Lens info
                if (exifData.hasKey("lensMake")) {
                    exifData.getString("lensMake")?.let {
                        exif.setAttribute(ExifInterface.TAG_LENS_MAKE, it)
                    }
                }
                if (exifData.hasKey("lensModel")) {
                    exifData.getString("lensModel")?.let {
                        exif.setAttribute(ExifInterface.TAG_LENS_MODEL, it)
                    }
                }
                
                // Additional camera settings
                if (exifData.hasKey("flash") && !exifData.isNull("flash")) {
                    exif.setAttribute(ExifInterface.TAG_FLASH, exifData.getInt("flash").toString())
                }
                if (exifData.hasKey("whiteBalance") && !exifData.isNull("whiteBalance")) {
                    exif.setAttribute(ExifInterface.TAG_WHITE_BALANCE, exifData.getInt("whiteBalance").toString())
                }
                if (exifData.hasKey("meteringMode") && !exifData.isNull("meteringMode")) {
                    exif.setAttribute(ExifInterface.TAG_METERING_MODE, exifData.getInt("meteringMode").toString())
                }
                if (exifData.hasKey("exposureProgram") && !exifData.isNull("exposureProgram")) {
                    exif.setAttribute(ExifInterface.TAG_EXPOSURE_PROGRAM, exifData.getInt("exposureProgram").toString())
                }
                if (exifData.hasKey("colorSpace") && !exifData.isNull("colorSpace")) {
                    exif.setAttribute(ExifInterface.TAG_COLOR_SPACE, exifData.getInt("colorSpace").toString())
                }
                
                // IPTC-equivalent EXIF tags
                if (exifData.hasKey("iptcCaption")) {
                    exifData.getString("iptcCaption")?.let {
                        exif.setAttribute(ExifInterface.TAG_IMAGE_DESCRIPTION, it)
                    }
                }
                if (exifData.hasKey("iptcCopyright")) {
                    exifData.getString("iptcCopyright")?.let {
                        exif.setAttribute(ExifInterface.TAG_COPYRIGHT, it)
                    }
                }
                if (exifData.hasKey("iptcCreator")) {
                    exifData.getString("iptcCreator")?.let {
                        exif.setAttribute(ExifInterface.TAG_ARTIST, it)
                    }
                }
                
                exif.saveAttributes()
                
                val result = Arguments.createMap()
                result.putBoolean("success", true)
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("E_WRITE", "Failed to write EXIF: ${e.message}")
            }
        }.start()
    }

    @ReactMethod
    fun saveQuickTimeToLibrary(path: String, promise: Promise) {
        Thread {
            try {
                val srcFile = File(if (path.startsWith("file://")) path.removePrefix("file://") else path)
                if (!srcFile.exists()) {
                    promise.reject("E_FILE", "Source file not found: $path")
                    return@Thread
                }

                val moviesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES)
                if (moviesDir == null) {
                    promise.reject("E_DIR", "Movies directory not available")
                    return@Thread
                }
                if (!moviesDir.exists()) {
                    moviesDir.mkdirs()
                }

                val destFile = File(moviesDir, srcFile.name)
                var counter = 1
                var actualDest = destFile
                while (actualDest.exists()) {
                    val nameWithoutExt = srcFile.nameWithoutExtension
                    val ext = srcFile.extension
                    actualDest = File(moviesDir, "${nameWithoutExt}_${counter}.${ext}")
                    counter++
                }

                srcFile.copyTo(actualDest, overwrite = true)

                MediaScannerConnection.scanFile(
                    reactApplicationContext,
                    arrayOf(actualDest.absolutePath),
                    arrayOf("video/quicktime"),
                    null
                )

                val result = Arguments.createMap()
                result.putBoolean("success", true)
                result.putString("path", actualDest.absolutePath)
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("E_SAVE", "Failed to save .mov: ${e.message}")
            }
        }.start()
    }

    /**
     * Direct MediaStore insertion for video files. Bypasses MediaScannerConnection
     * which fails with "Could not create asset" on unsupported codecs.
     * Works for MP4, MOV, M4V, 3GP, MKV, AVI, WebM, etc.
     */
    @ReactMethod
    fun saveVideoToLibrary(path: String, promise: Promise) {
        Thread {
            try {
                val srcFile = File(if (path.startsWith("file://")) path.removePrefix("file://") else path)
                if (!srcFile.exists()) {
                    promise.reject("E_FILE", "Source file not found: $path")
                    return@Thread
                }

                val mimeType = getVideoMimeType(srcFile.name)
                val displayName = srcFile.name
                val resolver = reactApplicationContext.contentResolver

                val contentValues = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.Video.Media.DISPLAY_NAME, displayName)
                    put(android.provider.MediaStore.Video.Media.MIME_TYPE, mimeType)
                    put(android.provider.MediaStore.Video.Media.SIZE, srcFile.length())
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        put(android.provider.MediaStore.Video.Media.RELATIVE_PATH, android.os.Environment.DIRECTORY_MOVIES)
                        put(android.provider.MediaStore.Video.Media.IS_PENDING, 1)
                    }
                }

                val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    resolver.insert(android.provider.MediaStore.Video.Media.getContentUri(android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY), contentValues)
                } else {
                    val moviesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES)
                    if (moviesDir == null) {
                        promise.reject("E_DIR", "Movies directory not available")
                        return@Thread
                    }
                    if (!moviesDir.exists()) moviesDir.mkdirs()
                    val destFile = File(moviesDir, displayName)
                    // Handle duplicate names
                    var actualDest = destFile
                    var counter = 1
                    while (actualDest.exists()) {
                        val nameWithoutExt = srcFile.nameWithoutExtension
                        val ext = srcFile.extension
                        actualDest = File(moviesDir, "${nameWithoutExt}_${counter}.${ext}")
                        counter++
                    }
                    contentValues.put(android.provider.MediaStore.Video.Media.DATA, actualDest.absolutePath)
                    resolver.insert(android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI, contentValues)
                }

                if (uri == null) {
                    promise.reject("E_INSERT", "MediaStore insert returned null")
                    return@Thread
                }

                // Copy file bytes to MediaStore output stream
                resolver.openOutputStream(uri)?.use { outputStream ->
                    srcFile.inputStream().use { inputStream ->
                        inputStream.copyTo(outputStream)
                    }
                } ?: run {
                    promise.reject("E_STREAM", "Failed to open output stream for MediaStore")
                    return@Thread
                }

                // Finalize on Android 10+
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val finalizeValues = android.content.ContentValues().apply {
                        put(android.provider.MediaStore.Video.Media.IS_PENDING, 0)
                    }
                    resolver.update(uri, finalizeValues, null, null)
                }

                val result = Arguments.createMap()
                result.putBoolean("success", true)
                result.putString("uri", uri.toString())
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("E_SAVE", "saveVideoToLibrary failed: ${e.message}")
            }
        }.start()
    }

    private fun getVideoMimeType(filename: String): String {
        val ext = filename.substringAfterLast('.', "").lowercase(Locale.ROOT)
        return when (ext) {
            "mp4" -> "video/mp4"
            "mov" -> "video/quicktime"
            "m4v" -> "video/x-m4v"
            "avi" -> "video/x-msvideo"
            "mkv" -> "video/x-matroska"
            "3gp" -> "video/3gpp"
            "3g2" -> "video/3gpp2"
            "webm" -> "video/webm"
            "wmv" -> "video/x-ms-wmv"
            "flv" -> "video/x-flv"
            "mpg", "mpeg" -> "video/mpeg"
            "mts", "m2ts" -> "video/mp2t"
            else -> "video/mp4"
        }
    }
}
