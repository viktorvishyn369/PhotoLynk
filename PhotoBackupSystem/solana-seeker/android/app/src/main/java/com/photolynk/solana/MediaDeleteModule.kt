package com.photolynk.solana

import android.app.Activity
import android.content.ContentUris
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import com.facebook.react.bridge.*
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

class MediaDeleteModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private val deletedFolderName = "PhotoLynkDeleted"

    private val activityEventListener: ActivityEventListener = object : BaseActivityEventListener() {
        override fun onActivityResult(activity: Activity?, requestCode: Int, resultCode: Int, data: android.content.Intent?) {
            Log.d("MediaDelete", "onActivityResult: requestCode=$requestCode, resultCode=$resultCode")
            if (requestCode != DELETE_REQUEST_CODE) return

            val p = pendingDeletePromise
            val copiedFiles = pendingCopiedFiles
            pendingDeletePromise = null
            pendingCopiedFiles = null
            
            if (p == null) {
                Log.w("MediaDelete", "No pending promise found")
                return
            }

            if (resultCode == Activity.RESULT_OK) {
                Log.d("MediaDelete", "User confirmed deletion - keeping ${copiedFiles?.size ?: 0} backup copies")
                p.resolve(true)
            } else {
                Log.d("MediaDelete", "User cancelled or denied deletion - removing backup copies")
                // User cancelled - delete the backup copies we made
                if (copiedFiles != null && copiedFiles.isNotEmpty()) {
                    for (file in copiedFiles) {
                        try {
                            if (file.exists()) {
                                val deleted = file.delete()
                                Log.d("MediaDelete", "Removed backup copy ${file.name}: $deleted")
                            }
                        } catch (e: Exception) {
                            Log.w("MediaDelete", "Failed to remove backup copy ${file.name}: ${e.message}")
                        }
                    }
                }
                p.resolve(false)
            }
        }
    }

    init {
        reactContext.addActivityEventListener(activityEventListener)
    }

    override fun getName(): String = "MediaDelete"

    // Get or create the PhotoLynkDeleted folder
    private fun getOrCreateDeletedFolder(): File? {
        try {
            val picturesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
            val deletedFolder = File(picturesDir, deletedFolderName)
            
            if (!deletedFolder.exists()) {
                val created = deletedFolder.mkdirs()
                Log.d("MediaDelete", "Created PhotoLynkDeleted folder: $created at ${deletedFolder.absolutePath}")
            } else {
                Log.d("MediaDelete", "PhotoLynkDeleted folder exists at ${deletedFolder.absolutePath}")
            }
            
            return if (deletedFolder.exists()) deletedFolder else null
        } catch (e: Exception) {
            Log.e("MediaDelete", "Failed to create PhotoLynkDeleted folder: ${e.message}")
            return null
        }
    }

    // Copy a file to the PhotoLynkDeleted folder
    private fun copyToDeletedFolder(uri: Uri, deletedFolder: File): File? {
        try {
            val contentResolver = reactApplicationContext.contentResolver
            
            // Get the original filename
            var fileName = "deleted_${System.currentTimeMillis()}"
            val cursor = contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
            cursor?.use {
                if (it.moveToFirst()) {
                    fileName = it.getString(0) ?: fileName
                }
            }
            
            // Ensure unique filename
            var destFile = File(deletedFolder, fileName)
            var counter = 1
            while (destFile.exists()) {
                val nameWithoutExt = fileName.substringBeforeLast(".")
                val ext = if (fileName.contains(".")) ".${fileName.substringAfterLast(".")}" else ""
                destFile = File(deletedFolder, "${nameWithoutExt}_$counter$ext")
                counter++
            }
            
            // Copy the file
            contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(destFile).use { output ->
                    input.copyTo(output)
                }
            }
            
            Log.d("MediaDelete", "Copied to: ${destFile.absolutePath}")
            
            // Notify MediaStore about the new file so it appears in gallery
            android.media.MediaScannerConnection.scanFile(
                reactApplicationContext,
                arrayOf(destFile.absolutePath),
                null,
                null
            )
            
            return destFile
        } catch (e: Exception) {
            Log.e("MediaDelete", "Failed to copy file: ${e.message}")
            return null
        }
    }

    @ReactMethod
    fun deleteAssets(assetIds: ReadableArray, promise: Promise) {
        try {
            val activity = currentActivity
            if (activity == null) {
                promise.reject("E_ACTIVITY", "Activity is null")
                return
            }

            val uris = mutableListOf<Uri>()
            
            Log.d("MediaDelete", "deleteAssets called with ${assetIds.size()} items")
            
            for (i in 0 until assetIds.size()) {
                val assetId = assetIds.getString(i) ?: continue
                Log.d("MediaDelete", "Processing assetId: $assetId")
                
                // Try to find the content URI for this asset ID
                val uri = findContentUri(assetId)
                if (uri != null) {
                    Log.d("MediaDelete", "Found URI: $uri")
                    uris.add(uri)
                } else {
                    Log.w("MediaDelete", "Could not find URI for assetId: $assetId")
                }
            }

            Log.d("MediaDelete", "Total URIs to delete: ${uris.size} out of ${assetIds.size()} requested")
            
            if (uris.isEmpty()) {
                Log.e("MediaDelete", "ERROR: No valid URIs found for any asset IDs! Files may have been already deleted or moved.")
                promise.reject("E_NOT_FOUND", "No assets found for the provided IDs")
                return
            }
            
            // Log if some files weren't found (partial match)
            if (uris.size < assetIds.size()) {
                Log.w("MediaDelete", "Only found ${uris.size} of ${assetIds.size()} files - some may have been already deleted")
            }

            // Delete the files (copy to PhotoLynkDeleted happens BEFORE confirmation on Android 11+)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // Android 11+ (API 30+): Use createDeleteRequest for scoped storage
                if (pendingDeletePromise != null) {
                    promise.reject("E_BUSY", "A delete request is already in progress")
                    return
                }
                
                // Copy files to PhotoLynkDeleted BEFORE showing confirmation dialog
                // (because after user confirms, Android deletes the files immediately)
                val copiedFiles = mutableListOf<File>()
                val deletedFolder = getOrCreateDeletedFolder()
                if (deletedFolder != null) {
                    Log.d("MediaDelete", "Android 11+: Copying ${uris.size} files to PhotoLynkDeleted before confirmation...")
                    for (uri in uris) {
                        try {
                            val copiedFile = copyToDeletedFolder(uri, deletedFolder)
                            if (copiedFile != null) {
                                copiedFiles.add(copiedFile)
                            }
                        } catch (e: Exception) {
                            Log.w("MediaDelete", "Failed to copy $uri: ${e.message}")
                        }
                    }
                    Log.d("MediaDelete", "Copied ${copiedFiles.size} files to PhotoLynkDeleted")
                }
                
                // Store copied files so we can delete them if user cancels
                pendingCopiedFiles = copiedFiles
                
                Log.d("MediaDelete", "Using createDeleteRequest for Android 11+")
                val pendingIntent = MediaStore.createDeleteRequest(
                    reactApplicationContext.contentResolver,
                    uris
                )
                activity.startIntentSenderForResult(
                    pendingIntent.intentSender,
                    DELETE_REQUEST_CODE,
                    null, 0, 0, 0
                )
                pendingDeletePromise = promise
            } else if (Build.VERSION.SDK_INT == Build.VERSION_CODES.Q) {
                // Android 10 (API 29): Scoped storage but no createDeleteRequest
                // Copy to PhotoLynkDeleted BEFORE delete (no batch confirmation dialog)
                val deletedFolder = getOrCreateDeletedFolder()
                if (deletedFolder != null) {
                    Log.d("MediaDelete", "Android 10: Copying ${uris.size} files to PhotoLynkDeleted before delete...")
                    for (uri in uris) {
                        try {
                            copyToDeletedFolder(uri, deletedFolder)
                        } catch (e: Exception) {
                            Log.w("MediaDelete", "Failed to copy $uri: ${e.message}")
                        }
                    }
                }
                
                Log.d("MediaDelete", "Android 10: Attempting direct delete with exception handling")
                var deleted = 0
                var needsPermission = false
                for (uri in uris) {
                    try {
                        val rows = reactApplicationContext.contentResolver.delete(uri, null, null)
                        if (rows > 0) {
                            deleted++
                            Log.d("MediaDelete", "Deleted: $uri")
                        }
                    } catch (e: android.app.RecoverableSecurityException) {
                        // Android 10 requires user permission for each file
                        Log.w("MediaDelete", "RecoverableSecurityException for $uri - needs user permission")
                        needsPermission = true
                    } catch (e: SecurityException) {
                        Log.w("MediaDelete", "SecurityException for $uri: ${e.message}")
                    } catch (e: Exception) {
                        Log.e("MediaDelete", "Delete error for $uri: ${e.message}")
                    }
                }
                if (needsPermission) {
                    // On Android 10, we can't batch permission requests easily
                    // Return partial success
                    Log.w("MediaDelete", "Some files need permission on Android 10")
                }
                promise.resolve(deleted > 0)
            } else {
                // Android 7-9 (API 24-28): Direct delete works
                // Copy to PhotoLynkDeleted BEFORE delete (no confirmation dialog)
                val deletedFolder = getOrCreateDeletedFolder()
                if (deletedFolder != null) {
                    Log.d("MediaDelete", "Android 7-9: Copying ${uris.size} files to PhotoLynkDeleted before delete...")
                    for (uri in uris) {
                        try {
                            copyToDeletedFolder(uri, deletedFolder)
                        } catch (e: Exception) {
                            Log.w("MediaDelete", "Failed to copy $uri: ${e.message}")
                        }
                    }
                }
                
                Log.d("MediaDelete", "Android 7-9: Direct delete")
                var deleted = 0
                for (uri in uris) {
                    try {
                        val rows = reactApplicationContext.contentResolver.delete(uri, null, null)
                        if (rows > 0) {
                            deleted++
                            Log.d("MediaDelete", "Deleted: $uri")
                        } else {
                            Log.w("MediaDelete", "Delete returned 0 rows for: $uri")
                        }
                    } catch (e: Exception) {
                        Log.e("MediaDelete", "Delete error for $uri: ${e.message}")
                    }
                }
                promise.resolve(deleted > 0)
            }
        } catch (e: Exception) {
            promise.reject("E_DELETE", "Failed to delete assets: ${e.message}", e)
        }
    }

    private fun findContentUri(assetId: String): Uri? {
        // expo-media-library asset IDs on Android can be:
        // 1. Just a numeric ID like "1234"
        // 2. A content URI like "content://media/external/images/media/1234"
        // 3. A path-based ID like "/storage/emulated/0/DCIM/Camera/IMG_1234.jpg"
        // 4. A prefixed ID like "ph://1234" or similar
        
        Log.d("MediaDelete", "findContentUri input: $assetId")
        
        // If it's already a content URI, parse it directly
        if (assetId.startsWith("content://")) {
            val uri = Uri.parse(assetId)
            Log.d("MediaDelete", "Parsed as content URI: $uri")
            return uri
        }
        
        // If it's a file path, try to find it by DATA column first
        if (assetId.startsWith("/")) {
            Log.d("MediaDelete", "Trying to find by file path: $assetId")
            val uri = findByFilePath(assetId)
            if (uri != null) {
                Log.d("MediaDelete", "Found by file path: $uri")
                return uri
            }
            // Also try by DISPLAY_NAME (filename only) as fallback for scoped storage
            val fileName = assetId.substringAfterLast("/")
            Log.d("MediaDelete", "Trying to find by filename: $fileName")
            val uriByName = findByDisplayName(fileName)
            if (uriByName != null) {
                Log.d("MediaDelete", "Found by display name: $uriByName")
                return uriByName
            }
        }
        
        // Check if it's a pure numeric ID (expo-media-library format)
        val pureNumericId = assetId.toLongOrNull()
        if (pureNumericId != null && pureNumericId > 0) {
            Log.d("MediaDelete", "Pure numeric ID: $pureNumericId")
            // Check if this ID exists in images
            if (existsInCollection(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, pureNumericId)) {
                val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, pureNumericId)
                Log.d("MediaDelete", "Found in images: $uri")
                return uri
            }
            // Check if this ID exists in videos
            if (existsInCollection(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, pureNumericId)) {
                val uri = ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, pureNumericId)
                Log.d("MediaDelete", "Found in videos: $uri")
                return uri
            }
        }
        
        // Try extracting ID from content URI pattern embedded in string
        // e.g., "content://media/external/images/media/1234" or just the trailing number
        val contentUriMatch = Regex("content://media/external/(images|video)/media/(\\d+)").find(assetId)
        if (contentUriMatch != null) {
            val mediaType = contentUriMatch.groupValues[1]
            val mediaId = contentUriMatch.groupValues[2].toLongOrNull()
            if (mediaId != null && mediaId > 0) {
                val baseUri = if (mediaType == "images") MediaStore.Images.Media.EXTERNAL_CONTENT_URI else MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                val uri = ContentUris.withAppendedId(baseUri, mediaId)
                Log.d("MediaDelete", "Extracted from content URI pattern: $uri")
                return uri
            }
        }
        
        // Last resort: try to extract trailing numeric ID (but be careful with paths)
        // Only use this if the ID doesn't look like a file path
        if (!assetId.contains("/") && !assetId.contains(".")) {
            val numericId = assetId.replace(Regex("[^0-9]"), "").toLongOrNull()
            Log.d("MediaDelete", "Extracted numeric ID (last resort): $numericId from $assetId")
            
            if (numericId != null && numericId > 0) {
                // Check if this ID exists in images
                if (existsInCollection(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, numericId)) {
                    val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, numericId)
                    Log.d("MediaDelete", "Found in images: $uri")
                    return uri
                }
                // Check if this ID exists in videos
                if (existsInCollection(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, numericId)) {
                    val uri = ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, numericId)
                    Log.d("MediaDelete", "Found in videos: $uri")
                    return uri
                }
                Log.w("MediaDelete", "Numeric ID $numericId not found in images or videos")
            }
        }

        Log.e("MediaDelete", "Could not find content URI for: $assetId")
        return null
    }
    
    private fun findByDisplayName(displayName: String): Uri? {
        try {
            // Try images first
            var cursor = reactApplicationContext.contentResolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.MediaColumns._ID),
                "${MediaStore.MediaColumns.DISPLAY_NAME} = ?",
                arrayOf(displayName),
                null
            )
            cursor?.use {
                if (it.moveToFirst()) {
                    val id = it.getLong(0)
                    return ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
                }
            }
            
            // Try videos
            cursor = reactApplicationContext.contentResolver.query(
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.MediaColumns._ID),
                "${MediaStore.MediaColumns.DISPLAY_NAME} = ?",
                arrayOf(displayName),
                null
            )
            cursor?.use {
                if (it.moveToFirst()) {
                    val id = it.getLong(0)
                    return ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, id)
                }
            }
        } catch (e: Exception) {
            Log.e("MediaDelete", "findByDisplayName error: ${e.message}")
        }
        return null
    }
    
    private fun findByFilePath(filePath: String): Uri? {
        try {
            // Try images first
            var cursor = reactApplicationContext.contentResolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.MediaColumns._ID),
                "${MediaStore.MediaColumns.DATA} = ?",
                arrayOf(filePath),
                null
            )
            cursor?.use {
                if (it.moveToFirst()) {
                    val id = it.getLong(0)
                    return ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
                }
            }
            
            // Try videos
            cursor = reactApplicationContext.contentResolver.query(
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.MediaColumns._ID),
                "${MediaStore.MediaColumns.DATA} = ?",
                arrayOf(filePath),
                null
            )
            cursor?.use {
                if (it.moveToFirst()) {
                    val id = it.getLong(0)
                    return ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, id)
                }
            }
        } catch (e: Exception) {
            Log.e("MediaDelete", "findByFilePath error: ${e.message}")
        }
        return null
    }

    private fun existsInCollection(collectionUri: Uri, id: Long): Boolean {
        try {
            // Query the collection with a WHERE clause for the specific ID
            val cursor = reactApplicationContext.contentResolver.query(
                collectionUri,
                arrayOf(MediaStore.MediaColumns._ID),
                "${MediaStore.MediaColumns._ID} = ?",
                arrayOf(id.toString()),
                null
            )
            cursor?.use {
                val exists = it.moveToFirst()
                Log.d("MediaDelete", "existsInCollection($collectionUri, $id) = $exists")
                return exists
            }
        } catch (e: Exception) {
            Log.e("MediaDelete", "existsInCollection error: ${e.message}")
        }
        return false
    }

    companion object {
        const val DELETE_REQUEST_CODE = 42069
        var pendingDeletePromise: Promise? = null
        var pendingCopiedFiles: List<File>? = null
    }
}
