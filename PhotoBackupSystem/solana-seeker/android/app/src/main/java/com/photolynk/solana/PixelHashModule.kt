package com.photolynk.solana

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.net.Uri
import android.os.Build
import androidx.exifinterface.media.ExifInterface
import com.facebook.react.bridge.*
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

class PixelHashModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "PixelHash"

    @ReactMethod
    fun hashImagePixels(path: String, promise: Promise) {
        // Uses 9x8 dHash (difference hash) - more resistant to compression/transcoding than aHash
        // Compares adjacent horizontal pixels, producing 64-bit hash
        Thread {
            var bitmap: Bitmap? = null
            var normalized: Bitmap? = null
            try {
                // Decode image - use ImageDecoder for Android 9+ (better GIF/animated support)
                val filePath = if (path.startsWith("file://")) path.removePrefix("file://") else path
                val isContentUri = path.startsWith("content://")
                
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    // Android 9+ - use ImageDecoder for better format support
                    try {
                        val source = if (isContentUri) {
                            ImageDecoder.createSource(reactApplicationContext.contentResolver, Uri.parse(path))
                        } else {
                            ImageDecoder.createSource(File(filePath))
                        }
                        bitmap = ImageDecoder.decodeBitmap(source) { decoder, _, _ ->
                            // Force software rendering for consistent pixel access
                            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                            // For animated images, just get first frame
                            decoder.setTargetSampleSize(1)
                        }
                    } catch (e: Exception) {
                        // Fallback to BitmapFactory if ImageDecoder fails
                        bitmap = null
                    }
                }
                
                // Fallback to BitmapFactory (Android 8 and below, or if ImageDecoder failed)
                if (bitmap == null) {
                    val inputStream: InputStream? = if (isContentUri) {
                        reactApplicationContext.contentResolver.openInputStream(Uri.parse(path))
                    } else {
                        java.io.FileInputStream(filePath)
                    }

                    if (inputStream == null) {
                        promise.reject("E_FILE", "Cannot open file: $path")
                        return@Thread
                    }
                    
                    bitmap = BitmapFactory.decodeStream(inputStream)
                    inputStream.close()
                }

                if (bitmap == null) {
                    promise.reject("E_DECODE", "Cannot decode image: $path")
                    return@Thread
                }

                // Use high-quality scaling to match Sharp's lanczos resize
                // createScaledBitmap with filter=true uses bilinear filtering which is closer to Sharp
                val hashWidth = 9
                val hashHeight = 8
                
                val scaled = Bitmap.createScaledBitmap(bitmap!!, hashWidth, hashHeight, true)
                bitmap!!.recycle()
                bitmap = null
                
                val scaledPixels = IntArray(hashWidth * hashHeight)
                scaled.getPixels(scaledPixels, 0, hashWidth, 0, 0, hashWidth, hashHeight)
                scaled.recycle()

                // Compute grayscale values in 2D array for easier adjacent pixel comparison
                val grayValues = Array(hashHeight) { IntArray(hashWidth) }

                for (y in 0 until hashHeight) {
                    for (x in 0 until hashWidth) {
                        val pixel = scaledPixels[y * hashWidth + x]
                        val r = Color.red(pixel)
                        val g = Color.green(pixel)
                        val b = Color.blue(pixel)
                        // Standard grayscale conversion
                        val gray = (r * 299 + g * 587 + b * 114) / 1000
                        grayValues[y][x] = gray
                    }
                }

                // Build dHash: compare each pixel to its right neighbor
                // 8 rows × 8 comparisons = 64 bits = 8 bytes = 16 hex chars
                val hashBytes = ByteArray(8)
                var bitIndex = 0

                for (y in 0 until hashHeight) {
                    for (x in 0 until (hashWidth - 1)) {
                        // If left pixel < right pixel, set bit to 1
                        if (grayValues[y][x] < grayValues[y][x + 1]) {
                            val byteIndex = bitIndex / 8
                            val bitPos = 7 - (bitIndex % 8)
                            hashBytes[byteIndex] = (hashBytes[byteIndex].toInt() or (1 shl bitPos)).toByte()
                        }
                        bitIndex++
                    }
                }

                val hexString = hashBytes.joinToString("") { "%02x".format(it) }
                promise.resolve(hexString)
            } catch (e: Exception) {
                bitmap?.recycle()
                normalized?.recycle()
                promise.reject("E_HASH", "Failed to hash image: ${e.message}", e)
            }
        }.start()
    }

    @ReactMethod
    fun hashPixelBufferSHA256(path: String, promise: Promise) {
        // Decodes image, scales to 256x256, and computes SHA-256 of the pixel buffer
        // This is pixel-exact at normalized resolution: ignores metadata, filename, format
        // 256x256 = 65536 pixels = 256KB to hash (fast) while still detecting any visual difference
        Thread {
            var bitmap: Bitmap? = null
            var scaled: Bitmap? = null
            try {
                val inputStream: InputStream? = if (path.startsWith("content://")) {
                    reactApplicationContext.contentResolver.openInputStream(Uri.parse(path))
                } else {
                    val filePath = if (path.startsWith("file://")) path.removePrefix("file://") else path
                    java.io.FileInputStream(filePath)
                }

                if (inputStream == null) {
                    promise.reject("E_FILE", "Cannot open file: $path")
                    return@Thread
                }
                
                bitmap = BitmapFactory.decodeStream(inputStream)
                inputStream.close()

                if (bitmap == null) {
                    promise.reject("E_DECODE", "Cannot decode image: $path")
                    return@Thread
                }

                // Scale to fixed 256x256 for fast hashing while maintaining pixel-exactness
                val hashSize = 256
                scaled = Bitmap.createScaledBitmap(bitmap!!, hashSize, hashSize, true)
                bitmap!!.recycle()
                bitmap = null
                
                val totalPixels = hashSize * hashSize
                
                // Extract RGBA pixel data from scaled bitmap
                val pixelBuffer = ByteArray(totalPixels * 4)
                for (y in 0 until hashSize) {
                    for (x in 0 until hashSize) {
                        val pixel = scaled!!.getPixel(x, y)
                        val offset = (y * hashSize + x) * 4
                        pixelBuffer[offset] = Color.red(pixel).toByte()
                        pixelBuffer[offset + 1] = Color.green(pixel).toByte()
                        pixelBuffer[offset + 2] = Color.blue(pixel).toByte()
                        pixelBuffer[offset + 3] = Color.alpha(pixel).toByte()
                    }
                }
                
                scaled!!.recycle()
                scaled = null

                // Compute SHA-256 of the scaled pixel buffer
                val digest = MessageDigest.getInstance("SHA-256")
                val hashBytes = digest.digest(pixelBuffer)
                
                val hexString = hashBytes.joinToString("") { "%02x".format(it) }
                promise.resolve(hexString)
            } catch (e: Exception) {
                bitmap?.recycle()
                scaled?.recycle()
                promise.reject("E_HASH", "Failed to hash pixel buffer: ${e.message}", e)
            }
        }.start()
    }

    @ReactMethod
    fun hashImageCorners(path: String, promise: Promise) {
        // Computes hash from 4 corners (10% region each), converted to grayscale
        // If corners match, photos likely have same scene/background
        Thread {
            var bitmap: Bitmap? = null
            try {
                // First pass: bounds only
                val bounds = BitmapFactory.Options().apply {
                    inJustDecodeBounds = true
                }
                val inputStreamBounds: InputStream? = if (path.startsWith("content://")) {
                    reactApplicationContext.contentResolver.openInputStream(Uri.parse(path))
                } else {
                    val filePath = if (path.startsWith("file://")) path.removePrefix("file://") else path
                    java.io.FileInputStream(filePath)
                }

                if (inputStreamBounds == null) {
                    promise.reject("E_FILE", "Cannot open file: $path")
                    return@Thread
                }

                BitmapFactory.decodeStream(inputStreamBounds, null, bounds)
                inputStreamBounds.close()

                // Decode sampled (corners hash is tolerant; avoid full-res decode)
                val maxDim = maxOf(bounds.outWidth, bounds.outHeight)
                var sampleSize = 1
                while (maxDim / sampleSize > 1024) {
                    sampleSize *= 2
                }

                val options = BitmapFactory.Options().apply {
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                    inSampleSize = sampleSize
                    inJustDecodeBounds = false
                }

                val inputStream: InputStream? = if (path.startsWith("content://")) {
                    reactApplicationContext.contentResolver.openInputStream(Uri.parse(path))
                } else {
                    val filePath = if (path.startsWith("file://")) path.removePrefix("file://") else path
                    java.io.FileInputStream(filePath)
                }

                if (inputStream == null) {
                    promise.reject("E_FILE", "Cannot open file: $path")
                    return@Thread
                }

                bitmap = BitmapFactory.decodeStream(inputStream, null, options)
                inputStream.close()

                if (bitmap == null) {
                    promise.reject("E_DECODE", "Cannot decode image: $path")
                    return@Thread
                }

                // Apply EXIF orientation
                try {
                    val orientation = readExifOrientation(path)
                    val rotated = applyExifOrientation(bitmap!!, orientation)
                    if (rotated !== bitmap) {
                        bitmap!!.recycle()
                        bitmap = rotated
                    }
                } catch (e: Exception) {
                    // ignore orientation errors
                }

                val origWidth = bitmap!!.width
                val origHeight = bitmap!!.height

                // 10% corner region from each corner
                val cornerW = maxOf(4, (origWidth * 0.10).toInt())
                val cornerH = maxOf(4, (origHeight * 0.10).toInt())

                // Helper to get grayscale at (x, y)
                fun getGray(x: Int, y: Int): Int {
                    val clampedX = x.coerceIn(0, origWidth - 1)
                    val clampedY = y.coerceIn(0, origHeight - 1)
                    val pixel = bitmap!!.getPixel(clampedX, clampedY)
                    val r = Color.red(pixel)
                    val g = Color.green(pixel)
                    val b = Color.blue(pixel)
                    return (r * 299 + g * 587 + b * 114) / 1000
                }

                // Sample 4 points from each corner (16 total samples)
                val cornerValues = IntArray(16)
                var idx = 0

                // Top-left corner
                for (dy in 0 until 2) {
                    for (dx in 0 until 2) {
                        val x = (cornerW * dx) / 2 + cornerW / 4
                        val y = (cornerH * dy) / 2 + cornerH / 4
                        cornerValues[idx++] = getGray(x, y)
                    }
                }

                // Top-right corner
                for (dy in 0 until 2) {
                    for (dx in 0 until 2) {
                        val x = origWidth - cornerW + (cornerW * dx) / 2 + cornerW / 4
                        val y = (cornerH * dy) / 2 + cornerH / 4
                        cornerValues[idx++] = getGray(x, y)
                    }
                }

                // Bottom-left corner
                for (dy in 0 until 2) {
                    for (dx in 0 until 2) {
                        val x = (cornerW * dx) / 2 + cornerW / 4
                        val y = origHeight - cornerH + (cornerH * dy) / 2 + cornerH / 4
                        cornerValues[idx++] = getGray(x, y)
                    }
                }

                // Bottom-right corner
                for (dy in 0 until 2) {
                    for (dx in 0 until 2) {
                        val x = origWidth - cornerW + (cornerW * dx) / 2 + cornerW / 4
                        val y = origHeight - cornerH + (cornerH * dy) / 2 + cornerH / 4
                        cornerValues[idx++] = getGray(x, y)
                    }
                }

                bitmap!!.recycle()
                bitmap = null

                // Compute average of corner values
                val avgCorner = cornerValues.sum() / cornerValues.size

                // Build 16-bit hash from corner samples (1 if > avg, 0 otherwise)
                var hashValue = 0
                for (i in 0 until 16) {
                    if (cornerValues[i] > avgCorner) {
                        hashValue = hashValue or (1 shl (15 - i))
                    }
                }

                val hexString = String.format("%04x", hashValue)
                promise.resolve(hexString)
            } catch (e: Exception) {
                bitmap?.recycle()
                promise.reject("E_CORNER_HASH", "Failed to compute corner hash: ${e.message}", e)
            }
        }.start()
    }

    @ReactMethod
    fun hashImageEdges(path: String, promise: Promise) {
        // Computes hash of 5% border from all 4 sides (edges only, not center)
        // If edges match, photos likely have same background/scene
        Thread {
            var bitmap: Bitmap? = null
            try {
                // First pass: bounds only
                val bounds = BitmapFactory.Options().apply {
                    inJustDecodeBounds = true
                }
                val inputStreamBounds: InputStream? = if (path.startsWith("content://")) {
                    reactApplicationContext.contentResolver.openInputStream(Uri.parse(path))
                } else {
                    val filePath = if (path.startsWith("file://")) path.removePrefix("file://") else path
                    java.io.FileInputStream(filePath)
                }

                if (inputStreamBounds == null) {
                    promise.reject("E_FILE", "Cannot open file: $path")
                    return@Thread
                }

                BitmapFactory.decodeStream(inputStreamBounds, null, bounds)
                inputStreamBounds.close()

                // Decode sampled (edge hash is tolerant; avoid full-res decode)
                val maxDim = maxOf(bounds.outWidth, bounds.outHeight)
                var decodeSampleSize = 1
                while (maxDim / decodeSampleSize > 1024) {
                    decodeSampleSize *= 2
                }

                val options = BitmapFactory.Options().apply {
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                    inSampleSize = decodeSampleSize
                    inJustDecodeBounds = false
                }

                val inputStream: InputStream? = if (path.startsWith("content://")) {
                    reactApplicationContext.contentResolver.openInputStream(Uri.parse(path))
                } else {
                    val filePath = if (path.startsWith("file://")) path.removePrefix("file://") else path
                    java.io.FileInputStream(filePath)
                }

                if (inputStream == null) {
                    promise.reject("E_FILE", "Cannot open file: $path")
                    return@Thread
                }

                bitmap = BitmapFactory.decodeStream(inputStream, null, options)
                inputStream.close()

                if (bitmap == null) {
                    promise.reject("E_DECODE", "Cannot decode image: $path")
                    return@Thread
                }

                // Apply EXIF orientation
                try {
                    val orientation = readExifOrientation(path)
                    val rotated = applyExifOrientation(bitmap!!, orientation)
                    if (rotated !== bitmap) {
                        bitmap!!.recycle()
                        bitmap = rotated
                    }
                } catch (e: Exception) {
                    // ignore orientation errors
                }

                val origWidth = bitmap!!.width
                val origHeight = bitmap!!.height

                // 5% border from each side
                val borderX = maxOf(1, (origWidth * 0.05).toInt())
                val borderY = maxOf(1, (origHeight * 0.05).toInt())

                // Sample count for edge hash (8 pixels per edge = 32 total edge samples)
                val edgeSampleCount = 8
                val edgeValues = IntArray(32)

                // Helper to get grayscale at (x, y)
                fun getGray(x: Int, y: Int): Int {
                    val pixel = bitmap!!.getPixel(x.coerceIn(0, origWidth - 1), y.coerceIn(0, origHeight - 1))
                    val r = Color.red(pixel)
                    val g = Color.green(pixel)
                    val b = Color.blue(pixel)
                    return (r * 299 + g * 587 + b * 114) / 1000
                }

                var idx = 0

                // Top edge (within borderY from top)
                for (i in 0 until edgeSampleCount) {
                    val x = (origWidth * i) / edgeSampleCount
                    val y = borderY / 2
                    edgeValues[idx++] = getGray(x, y)
                }

                // Bottom edge
                for (i in 0 until edgeSampleCount) {
                    val x = (origWidth * i) / edgeSampleCount
                    val y = origHeight - borderY / 2 - 1
                    edgeValues[idx++] = getGray(x, y)
                }

                // Left edge
                for (i in 0 until edgeSampleCount) {
                    val x = borderX / 2
                    val y = (origHeight * i) / edgeSampleCount
                    edgeValues[idx++] = getGray(x, y)
                }

                // Right edge
                for (i in 0 until edgeSampleCount) {
                    val x = origWidth - borderX / 2 - 1
                    val y = (origHeight * i) / edgeSampleCount
                    edgeValues[idx++] = getGray(x, y)
                }

                bitmap!!.recycle()
                bitmap = null

                // Compute average of edge values
                val avgEdge = edgeValues.sum() / edgeValues.size

                // Build 32-bit hash from edge samples (1 if > avg, 0 otherwise)
                var hashValue = 0
                for (i in 0 until 32) {
                    if (edgeValues[i] > avgEdge) {
                        hashValue = hashValue or (1 shl (31 - i))
                    }
                }

                val hexString = String.format("%08x", hashValue)
                promise.resolve(hexString)
            } catch (e: Exception) {
                bitmap?.recycle()
                promise.reject("E_EDGE_HASH", "Failed to compute edge hash: ${e.message}", e)
            }
        }.start()
    }

    @ReactMethod
    fun hashImagePerceptual(path: String, promise: Promise) {
        Thread {
            var originalBitmap: Bitmap? = null
            var resized: Bitmap? = null
            try {
                val inputStream: InputStream? = if (path.startsWith("content://")) {
                    reactApplicationContext.contentResolver.openInputStream(Uri.parse(path))
                } else {
                    val filePath = if (path.startsWith("file://")) path.removePrefix("file://") else path
                    java.io.FileInputStream(filePath)
                }

                if (inputStream == null) {
                    promise.reject("E_FILE", "Cannot open file: $path")
                    return@Thread
                }

                val options = BitmapFactory.Options().apply {
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                    inSampleSize = 1
                }
                
                // First pass: get dimensions
                options.inJustDecodeBounds = true
                BitmapFactory.decodeStream(inputStream, null, options)
                inputStream.close()
                
                // Calculate sample size to avoid OOM
                val maxDim = maxOf(options.outWidth, options.outHeight)
                var sampleSize = 1
                while (maxDim / sampleSize > 1024) {
                    sampleSize *= 2
                }
                
                // Second pass: decode with sample size
                val inputStream2: InputStream? = if (path.startsWith("content://")) {
                    reactApplicationContext.contentResolver.openInputStream(Uri.parse(path))
                } else {
                    val filePath = if (path.startsWith("file://")) path.removePrefix("file://") else path
                    java.io.FileInputStream(filePath)
                }
                
                if (inputStream2 == null) {
                    promise.reject("E_FILE", "Cannot reopen file: $path")
                    return@Thread
                }
                
                options.inJustDecodeBounds = false
                options.inSampleSize = sampleSize
                originalBitmap = BitmapFactory.decodeStream(inputStream2, null, options)
                inputStream2.close()

                if (originalBitmap == null) {
                    promise.reject("E_DECODE", "Cannot decode image: $path")
                    return@Thread
                }

                try {
                    val orientation = readExifOrientation(path)
                    val bmp0 = originalBitmap!!
                    val rotated = applyExifOrientation(bmp0, orientation)
                    if (rotated !== bmp0) {
                        bmp0.recycle()
                    }
                    originalBitmap = rotated
                } catch (e: Exception) {
                    // ignore
                }

                val ob = originalBitmap!!

                // Edge-inset crop (~10% on each side) to reduce UI overlays/borders affecting hashes
                val origW0 = ob.width
                val origH0 = ob.height
                var insetX = (origW0 * 0.10).toInt().coerceAtLeast(0)
                var insetY = (origH0 * 0.10).toInt().coerceAtLeast(0)
                insetX = insetX.coerceAtMost(((origW0 - 1) / 2).coerceAtLeast(0))
                insetY = insetY.coerceAtMost(((origH0 - 1) / 2).coerceAtLeast(0))
                val baseW = (origW0 - insetX * 2).coerceAtLeast(1)
                val baseH = (origH0 - insetY * 2).coerceAtLeast(1)
                val base = Bitmap.createBitmap(ob, insetX, insetY, baseW, baseH)
                ob.recycle()
                originalBitmap = null

                val cropRatio = 0.70
                val origW = base.width
                val origH = base.height
                val cropW = (origW * cropRatio).toInt().coerceAtLeast(1)
                val cropH = (origH * cropRatio).toInt().coerceAtLeast(1)
                val cropX = ((origW - cropW) / 2).coerceAtLeast(0)
                val cropY = ((origH - cropH) / 2).coerceAtLeast(0)
                val shiftUp = (origH * 0.10).toInt()
                var cropY2 = (cropY - shiftUp).coerceAtLeast(0)
                if (cropY2 + cropH > origH) cropY2 = (origH - cropH).coerceAtLeast(0)

                val cropRatio3 = 0.50
                val cropW3 = (origW * cropRatio3).toInt().coerceAtLeast(1)
                val cropH3 = (origH * cropRatio3).toInt().coerceAtLeast(1)
                val cropX3 = ((origW - cropW3) / 2).coerceAtLeast(0)
                val cropY3 = ((origH - cropH3) / 2).coerceAtLeast(0)

                val cropped1 = Bitmap.createBitmap(base, cropX, cropY, cropW, cropH)
                val cropped2 = Bitmap.createBitmap(base, cropX, cropY2, cropW, cropH)
                val cropped3 = Bitmap.createBitmap(base, cropX3, cropY3, cropW3, cropH3)
                base.recycle()

                val r1 = computePerceptualFromCropped(cropped1)
                val r2 = computePerceptualFromCropped(cropped2)
                val r3 = computePerceptualFromCropped(cropped3)

                val result = Arguments.createMap().apply {
                    putString("pHash", r1.pHash)
                    putString("dHash", r1.dHash)
                    putDouble("avgBrightness", r1.avgBrightness)
                    putDouble("blackRatio", r1.blackRatio)
                    putDouble("whiteRatio", r1.whiteRatio)
                    putDouble("avgRed", r1.avgRed)
                    putDouble("avgGreen", r1.avgGreen)
                    putDouble("avgBlue", r1.avgBlue)
                    putString("pHash2", r2.pHash)
                    putString("dHash2", r2.dHash)
                    putDouble("avgBrightness2", r2.avgBrightness)
                    putDouble("blackRatio2", r2.blackRatio)
                    putDouble("whiteRatio2", r2.whiteRatio)
                    putDouble("avgRed2", r2.avgRed)
                    putDouble("avgGreen2", r2.avgGreen)
                    putDouble("avgBlue2", r2.avgBlue)
                    putString("pHash3", r3.pHash)
                    putString("dHash3", r3.dHash)
                    putDouble("avgBrightness3", r3.avgBrightness)
                    putDouble("blackRatio3", r3.blackRatio)
                    putDouble("whiteRatio3", r3.whiteRatio)
                    putDouble("avgRed3", r3.avgRed)
                    putDouble("avgGreen3", r3.avgGreen)
                    putDouble("avgBlue3", r3.avgBlue)
                }
                promise.resolve(result)
            } catch (e: Exception) {
                originalBitmap?.recycle()
                resized?.recycle()
                promise.reject("E_PERCEPTUAL", "Failed to compute perceptual hash: ${e.message}", e)
            }
        }.start()
    }

    private data class PerceptualResult(
        val pHash: String,
        val dHash: String,
        val avgBrightness: Double,
        val blackRatio: Double,
        val whiteRatio: Double,
        val avgRed: Double,
        val avgGreen: Double,
        val avgBlue: Double
    )

    private fun computePerceptualFromCropped(cropped: Bitmap): PerceptualResult {
        val resized = Bitmap.createScaledBitmap(cropped, 32, 32, true)
        cropped.recycle()

        val width = resized.width
        val height = resized.height
        val grayscale = Array(height) { DoubleArray(width) }
        var totalBrightness = 0.0
        var totalRed = 0.0
        var totalGreen = 0.0
        var totalBlue = 0.0
        var blackCount = 0
        var whiteCount = 0

        for (y in 0 until height) {
            for (x in 0 until width) {
                val pixel = resized.getPixel(x, y)
                val r = Color.red(pixel)
                val g = Color.green(pixel)
                val b = Color.blue(pixel)
                val gray = 0.299 * r + 0.587 * g + 0.114 * b
                grayscale[y][x] = gray
                totalBrightness += gray
                totalRed += r
                totalGreen += g
                totalBlue += b
                if (gray < 10) blackCount++
                if (gray > 245) whiteCount++
            }
        }
        resized.recycle()

        val pixelCount = (width * height).toDouble()
        val avgBrightness = totalBrightness / pixelCount
        val blackRatio = blackCount.toDouble() / pixelCount
        val whiteRatio = whiteCount.toDouble() / pixelCount
        val avgRed = totalRed / pixelCount / 255.0
        val avgGreen = totalGreen / pixelCount / 255.0
        val avgBlue = totalBlue / pixelCount / 255.0

        val dctSize = 8
        val dctValues = DoubleArray(dctSize * dctSize)
        for (u in 0 until dctSize) {
            for (v in 0 until dctSize) {
                var sum = 0.0
                for (yy in 0 until dctSize) {
                    for (xx in 0 until dctSize) {
                        sum += grayscale[yy][xx] *
                                Math.cos((2 * xx + 1) * u * Math.PI / 16) *
                                Math.cos((2 * yy + 1) * v * Math.PI / 16)
                    }
                }
                dctValues[u * dctSize + v] = sum
            }
        }

        val dctForMedian = dctValues.drop(1).sorted()
        val median = if (dctForMedian.isNotEmpty()) dctForMedian[dctForMedian.size / 2] else 0.0

        var pHashBits: Long = 0
        for (i in 1 until minOf(65, dctValues.size)) {
            if (dctValues[i] > median) {
                pHashBits = pHashBits or (1L shl (i - 1))
            }
        }
        val pHash = String.format("%016x", pHashBits)

        var dHashBits: Long = 0
        var bitIndex = 0
        for (y in 0 until 8) {
            for (x in 0 until 8) {
                if (grayscale[y][x] < grayscale[y][x + 1]) {
                    dHashBits = dHashBits or (1L shl bitIndex)
                }
                bitIndex++
            }
        }
        val dHash = String.format("%016x", dHashBits)

        return PerceptualResult(
            pHash = pHash,
            dHash = dHash,
            avgBrightness = avgBrightness,
            blackRatio = blackRatio,
            whiteRatio = whiteRatio,
            avgRed = avgRed,
            avgGreen = avgGreen,
            avgBlue = avgBlue
        )
    }

    private fun readExifOrientation(path: String): Int {
        return if (path.startsWith("content://")) {
            val ins = reactApplicationContext.contentResolver.openInputStream(Uri.parse(path))
            if (ins == null) {
                ExifInterface.ORIENTATION_UNDEFINED
            } else {
                ins.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
            }
        } else {
            val filePath = if (path.startsWith("file://")) path.removePrefix("file://") else path
            ExifInterface(filePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        }
    }

    private fun applyExifOrientation(src: Bitmap, orientation: Int): Bitmap {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> {
                m.setRotate(180f)
                m.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                m.setRotate(90f)
                m.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_90 -> m.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                m.setRotate(-90f)
                m.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_270 -> m.setRotate(-90f)
            else -> return src
        }

        return Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
    }
}
