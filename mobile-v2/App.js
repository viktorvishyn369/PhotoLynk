import 'react-native-get-random-values';
import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, Alert, ScrollView, ActivityIndicator, Platform, Pressable, Button, Dimensions, SafeAreaView, KeyboardAvoidingView, Linking, Image, Clipboard, NativeModules } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy'; // Fixed: Use legacy import for downloadAsync support
import * as SecureStore from 'expo-secure-store';
import * as Application from 'expo-application';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import axios from 'axios';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const THEME = {
  bg: '#121212',
  card: '#1E1E1E',
  text: '#FFFFFF',
  textSec: '#AAAAAA',
  primary: '#BB86FC',
  secondary: '#03DAC6',
  error: '#CF6679'
};

export default function App() {
  const [view, setView] = useState('loading'); // loading, auth, home, settings
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [serverType, setServerType] = useState('local'); // 'local' or 'remote'
  const [localHost, setLocalHost] = useState('');
  const [remoteHost, setRemoteHost] = useState('');
  const [token, setToken] = useState(null);
  const [userId, setUserId] = useState(null);
  const [deviceUuid, setDeviceUuid] = useState(null);
  const [status, setStatus] = useState('Idle');
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    checkLogin();
  }, []);

  const openLink = async (url) => {
    try {
      await Linking.openURL(url);
    } catch (error) {
      console.error('Link open error', error);
      Alert.alert('Error', 'Could not open link');
    }
  };

  const getDeviceUUID = async (userEmail = null, userPassword = null) => {
    // UUID policy (per your request):
    // - Must be stable across reinstalls
    // - Must depend ONLY on credentials the user types: email + password
    // - We persist the resulting UUID so the app can use it later for API calls
    //   without requiring the password again.
    if (!userEmail) return null;

    const normalizedEmail = userEmail.toLowerCase();
    const persistedKey = `device_uuid_v3:${normalizedEmail}`;

    let persisted = null;
    try {
      persisted = await SecureStore.getItemAsync(persistedKey);
    } catch (e) {
      persisted = null;
    }

    // If password is not provided (e.g. app start), we can only use the persisted UUID.
    if (!userPassword) return persisted;

    // If password is provided (login/register), enforce email+password-derived UUID.
    const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const expected = uuidv5(`${normalizedEmail}:${userPassword}`, namespace);

    if (persisted !== expected) {
      try {
        await SecureStore.setItemAsync(persistedKey, expected);
      } catch (e) {
        // ignore
      }
    }

    return expected;
  };

  const normalizeHostInput = (value) => {
    const raw = (value || '').trim();
    if (!raw) return '';

    // Allow users to paste a URL; we strip scheme + path to keep it forgiving.
    let cleaned = raw.replace(/^https?:\/\//i, '');
    cleaned = cleaned.split('/')[0];

    // Strip query/hash leftovers if any
    cleaned = cleaned.split('?')[0].split('#')[0];

    // Host-only input: drop any :port, app will add ports automatically where needed.
    cleaned = cleaned.includes(':') ? cleaned.split(':')[0] : cleaned;
    return cleaned;
  };

  const getServerUrl = () => {
    const PORT = '3000';

    if (serverType === 'remote') {
      const host = normalizeHostInput(remoteHost);
      // Remote always uses HTTPS.
      return host ? `https://${host}` : 'https://localhost';
    }

    // Local always uses HTTP on :3000 and expects a LAN IP/host.
    const host = normalizeHostInput(localHost) || 'localhost';
    return `http://${host}:${PORT}`;
  };

  const checkLogin = async () => {
    // Load server settings
    const savedType = await SecureStore.getItemAsync('server_type');
    const savedLocalHost = await SecureStore.getItemAsync('local_host');
    const savedRemoteHost = await SecureStore.getItemAsync('remote_host');
    const savedRemoteUrl = await SecureStore.getItemAsync('remote_url');
    const savedRemoteIp = await SecureStore.getItemAsync('remote_ip');
    if (savedType) setServerType(savedType);

    if (savedLocalHost) setLocalHost(savedLocalHost);
    if (savedRemoteHost) setRemoteHost(savedRemoteHost);
    else if (savedRemoteUrl) setRemoteHost(savedRemoteUrl);
    else if (savedRemoteIp) setRemoteHost(savedRemoteIp);
    
    // Load stored email to get correct UUID
    const storedEmail = await SecureStore.getItemAsync('user_email');

    const storedToken = await SecureStore.getItemAsync('auth_token');
    const storedUserId = await SecureStore.getItemAsync('user_id');

    // Load persisted device UUID for this email (cannot regenerate without password)
    const uuid = await getDeviceUUID(storedEmail);
    setDeviceUuid(uuid);

    // If we have a token but we can't determine the UUID bound to it, force re-login.
    if (storedToken && storedEmail && !uuid) {
      await SecureStore.deleteItemAsync('auth_token');
      await SecureStore.deleteItemAsync('user_id');
      setToken(null);
      setUserId(null);
      setView('auth');
      Alert.alert('Login required', 'Your device identifier changed. Please login again so the server can re-bind your account to this device.');
      return;
    }

    if (storedToken) {
      setToken(storedToken);
      if (storedUserId) setUserId(parseInt(storedUserId));
      setView('home');
    } else {
      setView('auth');
    }
  };

  const handleAuth = async (type) => {
    console.log('handleAuth called:', type);
    console.log('Email:', email, 'Password:', password ? '***' : 'empty');
    
    if (!email || !password) {
      Alert.alert('Error', 'Please fill in all fields');
      return;
    }
    
    setLoading(true);
    try {
      // Save server settings
      await SecureStore.setItemAsync('server_type', serverType);
      if (serverType === 'remote') {
        await SecureStore.setItemAsync('remote_host', remoteHost);
      } else {
        await SecureStore.setItemAsync('local_host', localHost);
      }
      
      // Device UUID is derived from email+password and persisted.
      const deviceId = await getDeviceUUID(email, password);
      if (!deviceId) {
        Alert.alert('Device ID unavailable', 'Could not derive a device ID from your credentials. Please try again.');
        setLoading(false);
        return;
      }
      // Keep a generic copy for runtime usage (some flows need UUID before per-email lookup is ready)
      await SecureStore.setItemAsync('device_uuid', deviceId);
      setDeviceUuid(deviceId);
      const endpoint = type === 'register' ? '/api/register' : '/api/login';
      const res = await axios.post(getServerUrl() + endpoint, {
        email,
        password,
        device_uuid: deviceId,
        deviceUuid: deviceId,
        device_name: Platform.OS + ' ' + Platform.Version
      });

      console.log('Attempting auth:', type, `${getServerUrl()}${endpoint}`, {
        email,
        password,
        device_uuid: deviceId,
        deviceUuid: deviceId,
        device_name: Platform.OS + ' ' + Platform.Version
      });
      console.log('Auth response:', res.status);

      if (type === 'login') {
        const { token, userId } = res.data;
        await SecureStore.setItemAsync('auth_token', token);
        await SecureStore.setItemAsync('user_email', email); // Save email for UUID retrieval
        if (userId) {
          await SecureStore.setItemAsync('user_id', String(userId));
          setUserId(userId);
        }
        setToken(token);
        setView('home');
      } else {
        Alert.alert('Success', 'Account created! Please login.');
      }
    } catch (error) {
      // Only log actual server errors, not Metro bundler noise
      if (error.response) {
        console.error('Auth Error:', error.response.status, error.response.data);
        Alert.alert('Error', error.response?.data?.error || 'Connection failed');
      } else if (error.request) {
        console.error('Network Error - cannot reach server');
        Alert.alert('Error', 'Cannot reach server. Check your connection.');
      }
    } finally {
      setLoading(false);
    }
  };

  const cleanDeviceDuplicates = async () => {
    setLoading(true);
    setStatus('Scanning for duplicate photos/videos on this device...');

    try {
      // IMPORTANT: In Expo Go, react-native-blob-util is not linked and can crash even if wrapped
      // in try/catch due to module initialization. Guard by checking NativeModules first.
      const blobModulePresent = !!(
        NativeModules.ReactNativeBlobUtil ||
        NativeModules.RNBlobUtil ||
        NativeModules.RNFetchBlob
      );

      if (!blobModulePresent) {
        setStatus('Duplicate scan requires a development build (not Expo Go).');
        Alert.alert('Development Build Required', 'Clean Duplicates uses native file hashing for reliability. Please install a development build (expo run:ios/android) and try again.');
        setLoading(false);
        return;
      }

      let ReactNativeBlobUtil = null;
      try {
        const mod = require('react-native-blob-util');
        ReactNativeBlobUtil = mod && (mod.default || mod);
      } catch (e) {
        ReactNativeBlobUtil = null;
      }

      if (!ReactNativeBlobUtil || !ReactNativeBlobUtil.fs || typeof ReactNativeBlobUtil.fs.hash !== 'function') {
        setStatus('Duplicate scan requires a development build (not Expo Go).');
        Alert.alert('Development Build Required', 'Clean Duplicates uses native file hashing for reliability. Please install a development build (expo run:ios/android) and try again.');
        setLoading(false);
        return;
      }

      const permission = await MediaLibrary.requestPermissionsAsync(true);
      if (permission.status !== 'granted') {
        Alert.alert('Permission needed', 'We need access to photos to safely scan for duplicates.');
        setLoading(false);
        return;
      }

      const allAssets = await MediaLibrary.getAssetsAsync({
        first: 10000,
        mediaType: ['photo', 'video'],
      });

      if (!allAssets.assets || allAssets.assets.length === 0) {
        setStatus('No photos or videos found on this device.');
        Alert.alert('No Media', 'No photos or videos were found on this device.');
        setLoading(false);
        return;
      }

      setStatus(`Analyzing ${allAssets.assets.length} files for duplicates...`);

      const getUriForHashing = (assetInfo) => {
        const uri = (assetInfo && (assetInfo.localUri || assetInfo.uri)) || null;
        if (!uri) return null;
        // iOS can return ph:// which isn't directly readable by FileSystem
        if (typeof uri === 'string' && uri.startsWith('ph://')) return null;
        return uri;
      };

      // Hash-only duplicate detection: hash every readable asset.
      // No filename/date/size/metadata filtering is used for duplicate grouping.
      const hashGroups = {};
      let hashedCount = 0;
      let inspectFailed = 0;
      let hashSkipped = 0;
      let hashSkippedLarge = 0;
      let skippedPhUri = 0;
      let skippedNoUri = 0;
      let hashFailed = 0;
      const sampleSkipped = [];

      const normalizePathForHashing = (uri) => {
        if (!uri || typeof uri !== 'string') return null;
        let u = uri.trim();
        // Some iOS file URIs can include a #fragment or ?query (e.g. "...mp4#<token>")
        // which breaks native hashing. Remove those parts.
        const hashIdx = u.indexOf('#');
        if (hashIdx !== -1) u = u.slice(0, hashIdx);
        const qIdx = u.indexOf('?');
        if (qIdx !== -1) u = u.slice(0, qIdx);
        // Decode percent-encoding if present
        try {
          u = decodeURI(u);
        } catch (e) {
          // ignore
        }
        // iOS usually provides file:// URIs for local assets.
        if (u.startsWith('file://')) return u.replace('file://', '');
        // Android often uses content://; react-native-blob-util supports hashing URIs.
        return u;
      };

      for (let i = 0; i < allAssets.assets.length; i++) {
        const asset = allAssets.assets[i];
        let info;
        try {
          info = await MediaLibrary.getAssetInfoAsync(asset.id);
        } catch (e) {
          inspectFailed++;
          continue;
        }

        const rawUri = (info && (info.localUri || info.uri)) || null;
        if (!rawUri) {
          hashSkipped++;
          skippedNoUri++;
          if (sampleSkipped.length < 5) {
            sampleSkipped.push({ filename: info && info.filename ? info.filename : asset.filename, reason: 'missing uri', uri: '' });
          }
          continue;
        }

        if (typeof rawUri === 'string' && rawUri.startsWith('ph://')) {
          hashSkipped++;
          skippedPhUri++;
          if (sampleSkipped.length < 5) {
            sampleSkipped.push({ filename: info && info.filename ? info.filename : asset.filename, reason: 'ph:// (iCloud/Photos)', uri: rawUri });
          }
          continue;
        }

        const uri = getUriForHashing(info);
        if (!uri) {
          hashSkipped++;
          if (sampleSkipped.length < 5) {
            sampleSkipped.push({ filename: info && info.filename ? info.filename : asset.filename, reason: 'unreadable uri', uri: String(rawUri) });
          }
          continue;
        }

        const hashTarget = normalizePathForHashing(uri);
        if (!hashTarget) {
          hashSkipped++;
          continue;
        }

        try {
          const hashHex = await ReactNativeBlobUtil.fs.hash(hashTarget, 'sha256');

          hashedCount++;
          if (hashedCount % 10 === 0) {
            setStatus(`Hashing files... ${hashedCount} hashed`);
          }

          const key = hashHex;
          if (!hashGroups[key]) hashGroups[key] = [];
          hashGroups[key].push({ asset, info });
        } catch (e) {
          hashSkipped++;
          hashFailed++;
          if (sampleSkipped.length < 5) {
            sampleSkipped.push({ filename: info && info.filename ? info.filename : asset.filename, reason: 'hash failed', uri: String(rawUri) });
          }
          continue;
        }
      }

      const duplicateGroups = Object.values(hashGroups).filter(group => group.length > 1);

      if (duplicateGroups.length === 0) {
        const noteParts = [];
        noteParts.push(`Hashed ${hashedCount} item${hashedCount !== 1 ? 's' : ''}.`);
        if (hashSkipped > 0) noteParts.push(`Skipped: ${hashSkipped}`);
        if (hashFailed > 0) noteParts.push(`Hash failures: ${hashFailed}`);
        if (inspectFailed > 0) noteParts.push(`Asset-info failures: ${inspectFailed}`);
        if (sampleSkipped.length > 0) {
          noteParts.push('Examples (max 3):');
          sampleSkipped.slice(0, 3).forEach(s => {
            noteParts.push(`- ${s.filename}${s.reason ? ' — ' + s.reason : ''}`);
          });
        }
        const note = noteParts.length > 0 ? `\n\n${noteParts.join('\n')}` : '';
        setStatus('No exact duplicate photos or videos found on this device.');
        Alert.alert('No Duplicates', 'No exact duplicate photos or videos were found.' + note);
        setLoading(false);
        return;
      }

      let duplicateCount = 0;
      duplicateGroups.forEach(group => {
        // We keep one item per group and consider the rest duplicates
        duplicateCount += (group.length - 1);
      });

      const skippedParts = [];
      skippedParts.push(`Hashed ${hashedCount} item${hashedCount !== 1 ? 's' : ''}.`);
      if (hashSkipped > 0) skippedParts.push(`Skipped: ${hashSkipped}`);
      if (hashFailed > 0) skippedParts.push(`Hash failures: ${hashFailed}`);
      if (inspectFailed > 0) skippedParts.push(`Asset-info failures: ${inspectFailed}`);
      const skippedNote = skippedParts.length > 0 ? `\n\n${skippedParts.join('\n')}` : '';
      const summaryMessage = `Found ${duplicateCount} duplicate photo/video item${duplicateCount !== 1 ? 's' : ''} in ${duplicateGroups.length} group${duplicateGroups.length !== 1 ? 's' : ''} on this device.\n\nWe will keep the oldest item in each group and delete the newer duplicates.` + skippedNote;

      const confirmDeletion = (platformMessage) => {
        Alert.alert(
          'Clean Duplicates',
          summaryMessage + platformMessage,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => { setStatus('Duplicate scan cancelled.'); setLoading(false); } },
            {
              text: 'Delete Duplicates',
              style: 'destructive',
              onPress: async () => {
                try {
                  setStatus('Deleting duplicate photos/videos...');

                  const idsToDelete = [];
                  duplicateGroups.forEach(group => {
                    // Sort by creationTime so we keep the oldest (index 0) and delete newer duplicates
                    const sorted = [...group].sort((a, b) => {
                      const at = a.info && a.info.creationTime ? a.info.creationTime : a.asset.creationTime || 0;
                      const bt = b.info && b.info.creationTime ? b.info.creationTime : b.asset.creationTime || 0;
                      return at - bt;
                    });
                    for (let i = 1; i < sorted.length; i++) {
                      idsToDelete.push(sorted[i].asset.id);
                    }
                  });

                  if (idsToDelete.length === 0) {
                    setStatus('No duplicates selected for deletion.');
                    setLoading(false);
                    return;
                  }

                  await MediaLibrary.deleteAssetsAsync(idsToDelete);
                  const recoveryNote = Platform.OS === 'ios'
                    ? 'Deleted items were moved to "Recently Deleted" in Photos.'
                    : 'Deleted items were removed from this device.';
                  setStatus(`Deleted ${idsToDelete.length} duplicate item${idsToDelete.length !== 1 ? 's' : ''}.`);
                  Alert.alert(
                    'Duplicates Cleaned',
                    `Deleted ${idsToDelete.length} duplicate item${idsToDelete.length !== 1 ? 's' : ''}.\n\n${recoveryNote}`
                  );
                } catch (deleteError) {
                  console.error('Error deleting duplicates:', deleteError);
                  setStatus('Error while deleting duplicates: ' + (deleteError && deleteError.message ? deleteError.message : 'Unknown error'));
                  Alert.alert('Error', 'Could not delete some duplicates. Please try again or clean manually in the Photos app.');
                } finally {
                  setLoading(false);
                }
              }
            }
          ]
        );
      };

      if (Platform.OS === 'android') {
        confirmDeletion('\n\nOn Android, duplicates will be permanently deleted from device storage. This cannot be undone, so make sure your important photos are backed up first.');
      } else {
        confirmDeletion('\n\nOn iOS, duplicates will be moved to the system "Recently Deleted" area so they can be recovered for a limited time.');
      }
    } catch (error) {
      console.error('Duplicate scan error:', error);
      setStatus('Error during duplicate scan: ' + (error && error.message ? error.message : 'Unknown error'));
      Alert.alert('Error', 'Could not complete duplicate scan.');
      setLoading(false);
    }
  };

  const logout = async () => {
    await SecureStore.deleteItemAsync('auth_token');
    setToken(null);
    setView('auth');
  };

  const getAuthHeaders = async () => {
    // Always use the same user+device UUID that was used at login
    // so that X-Device-UUID matches the device_uuid inside the JWT
    const storedEmail = await SecureStore.getItemAsync('user_email');
    let uuid = deviceUuid;
    if (!uuid) {
      uuid = await getDeviceUUID(storedEmail);
    }
    if (!uuid) {
      uuid = await SecureStore.getItemAsync('device_uuid');
    }
    if (!uuid) {
      throw new Error('Device UUID missing. Please logout and login again.');
    }
    return {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Device-UUID': uuid
      }
    };
  };

  const backupPhotos = async () => {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'We need access to photos to back them up.');
      return;
    }

    setStatus('Scanning local media...');
    setProgress(0); // Reset progress
    setLoading(true);

    try {
      console.log('\n🔍 ===== BACKUP TRACE START =====');
      
      // 1. Get All Assets
      setStatus('Loading photos...');
      const allAssets = await MediaLibrary.getAssetsAsync({
        first: 10000,
        mediaType: ['photo', 'video'],
      });
      
      console.log(`📱 Total assets on device: ${allAssets.assets.length}`);
      
      // Exclude files already in PhotoSync album to prevent re-uploading restored files
      const albums = await MediaLibrary.getAlbumsAsync();
      console.log(`📂 All albums: ${albums.map(a => `${a.title} (${a.assetCount})`).join(', ')}`);
      
      const photoSyncAlbum = albums.find(a => a.title === 'PhotoSync');
      let excludedIds = new Set();
      
      if (photoSyncAlbum) {
        const albumAssets = await MediaLibrary.getAssetsAsync({
          album: photoSyncAlbum,
          first: 10000,
        });
        excludedIds = new Set(albumAssets.assets.map(a => a.id));
        console.log(`📂 PhotoSync album has ${excludedIds.size} files (will exclude)`);
      }
      
      const assets = {
        assets: allAssets.assets.filter(a => !excludedIds.has(a.id))
      };
      
      console.log(`📊 Assets to backup (after excluding PhotoSync): ${assets.assets.length}`);
      setStatus(`Found ${assets.assets.length} photos/videos to check...`);

      if (assets.assets.length === 0) {
        setStatus('No photos found to backup.');
        Alert.alert('No Photos', 'No photos or videos found on device.');
        setLoading(false);
        return;
      }

      // 2. Get Server List
      setStatus('Checking server files...');
      const config = await getAuthHeaders();
      const SERVER_URL = getServerUrl();
      console.log('Using server URL for backup:', SERVER_URL);
      const serverRes = await axios.get(`${SERVER_URL}/api/files`, config);
      
      console.log(`\n☁️  Server response: ${serverRes.data.files.length} files`);
      
      // Create case-insensitive set of server filenames
      const serverFiles = new Set(serverRes.data.files.map(f => f.filename.toLowerCase()));
      
      console.log(`📊 Server files (unique, lowercase): ${serverFiles.size}`);

      // 3. Identify Missing on Server
      const toUpload = [];
      const duplicateFilenames = {}; // Track duplicate filenames on device
      
      for (const asset of assets.assets) {
        // Get actual filename (iOS returns UUID in asset.filename, need to check assetInfo)
        const assetInfo = await MediaLibrary.getAssetInfoAsync(asset.id);
        const actualFilename = assetInfo.filename || asset.filename;
        const normalizedFilename = actualFilename.toLowerCase();
        
        // Track if we've seen this filename before (device duplicates)
        if (duplicateFilenames[normalizedFilename]) {
          duplicateFilenames[normalizedFilename]++;
          console.log(`⚠️ DUPLICATE on device: ${actualFilename} (${duplicateFilenames[normalizedFilename]} copies)`);
        } else {
          duplicateFilenames[normalizedFilename] = 1;
        }
        
        // Case-insensitive comparison (IMG_0001.MOV == img_0001.mov)
        const exists = serverFiles.has(normalizedFilename);
        console.log(`Checking ${actualFilename}: ${exists ? 'EXISTS on server' : 'MISSING from server'}`);
        if (!exists) {
          toUpload.push(asset);
        }
      }
      
      // Log device duplicates
      const deviceDuplicates = Object.entries(duplicateFilenames).filter(([_, count]) => count > 1);
      if (deviceDuplicates.length > 0) {
        console.log(`\n📱 Device has ${deviceDuplicates.length} duplicate filenames:`);
        deviceDuplicates.forEach(([filename, count]) => {
          console.log(`  - ${filename}: ${count} copies`);
        });
      }
      
      console.log(`Local: ${assets.assets.length}, Server: ${serverFiles.size}, To upload: ${toUpload.length}`);
      
      if (toUpload.length === 0) {
        setStatus(`All ${assets.assets.length} files already backed up.`);
        Alert.alert('Up to Date', `All ${assets.assets.length} photos/videos are already on the server.`);
        setLoading(false);
        return;
      }

      // Show summary before starting
      setStatus(`Ready to backup ${toUpload.length} of ${assets.assets.length} files...`);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Brief pause to show message

      // 4. Upload Loop with per-file error handling
      let successCount = 0;
      let duplicateCount = 0;
      let failedCount = 0;
      const failedFiles = [];
      
      for (let i = 0; i < toUpload.length; i++) {
        const asset = toUpload[i];
        try {
          setStatus(`Uploading ${i + 1}/${toUpload.length}: ${asset.filename}`);
          
          // Get file info
          const assetInfo = await MediaLibrary.getAssetInfoAsync(asset.id);
          const localUri = assetInfo.localUri || assetInfo.uri;

          if (!localUri) {
            console.warn(`Skipping ${asset.filename}: no URI`);
            failedCount++;
            failedFiles.push(asset.filename);
            continue;
          }

          // iOS fix: Use the actual filename from assetInfo, not the UUID
          // assetInfo.filename contains the real name like "IMG_0001.HEIC"
          const actualFilename = assetInfo.filename || asset.filename;

          const formData = new FormData();
          formData.append('file', {
            uri: localUri,
            name: actualFilename,
            type: asset.mediaType === 'video' ? 'video/mp4' : 'image/jpeg',
          });

          // Upload with timeout
          const uploadRes = await axios.post(`${SERVER_URL}/api/upload`, formData, {
            headers: {
              'Content-Type': 'multipart/form-data',
              ...config.headers
            },
            timeout: 30000 // 30 second timeout per file
          });
          
          // Check if server marked it as duplicate
          if (uploadRes.data.duplicate) {
            duplicateCount++;
            console.log(`⊘ Skipped (duplicate): ${actualFilename}`);
          } else {
            successCount++;
            console.log(`✓ Uploaded: ${actualFilename}`);
          }
        } catch (fileError) {
          console.error(`✗ Failed to upload ${asset.filename}:`, fileError.message);
          failedCount++;
          failedFiles.push(asset.filename);
        }
        
        setProgress((i + 1) / toUpload.length);
      }

      // Show detailed completion status
      console.log('\n📊 ===== BACKUP SUMMARY =====');
      console.log(`Total on device: ${allAssets.assets.length}`);
      console.log(`PhotoSync excluded: ${excludedIds.size}`);
      console.log(`To check: ${assets.assets.length}`);
      console.log(`On server before: ${serverFiles.size}`);
      console.log(`Marked for upload: ${toUpload.length}`);
      console.log(`Actually uploaded: ${successCount}`);
      console.log(`Duplicates skipped: ${duplicateCount}`);
      console.log(`Failed: ${failedCount}`);
      console.log('===== END BACKUP TRACE =====\n');
      
      if (failedCount === 0) {
        setStatus(`Backup Complete! Uploaded ${successCount} file${successCount !== 1 ? 's' : ''}.`);
        Alert.alert('Success', `Successfully backed up ${successCount} file${successCount !== 1 ? 's' : ''}.`);
      } else {
        setStatus(`Backup Complete: ${successCount} succeeded, ${failedCount} failed.`);
        Alert.alert('Partial Success', `Uploaded ${successCount} file${successCount !== 1 ? 's' : ''}.\n${failedCount} file${failedCount !== 1 ? 's' : ''} failed.`);
      }
      setProgress(0); // Reset progress after completion
    } catch (error) {
      console.error(error);
      setStatus('Error during backup: ' + error.message);
      setProgress(0); // Reset progress on error
    } finally {
      setLoading(false);
    }
  };

  const restorePhotos = async () => {
    setStatus('Requesting permissions...');
    setLoading(true);
    
    // Request permission to save to gallery ONCE at the start
    const permission = await MediaLibrary.requestPermissionsAsync(true); // true = write access
    if (permission.status !== 'granted') {
      Alert.alert('Permission Required', 'Media library permission is required to save photos to your gallery.');
      setLoading(false);
      return;
    }
    
    console.log('\n⬇️  ===== RESTORE TRACE START =====');
    
    setStatus('Checking server files...');
    setProgress(0); // Reset progress

    try {
      // 1. Get Server Files
      const config = await getAuthHeaders();
      const serverRes = await axios.get(`${getServerUrl()}/api/files`, config);
      const serverFiles = serverRes.data.files;
      console.log(`☁️  Server has ${serverFiles.length} files`);

      // 2. Get local device photos to check what already exists
      setStatus('Checking local photos...');
      const localAssets = await MediaLibrary.getAssetsAsync({
        first: 10000,
        mediaType: ['photo', 'video'],
      });
      
      console.log(`📱 Total assets on device: ${localAssets.assets.length}`);
      
      // Create a set of local filenames (case-insensitive for comparison)
      const localFilenames = new Set();
      const localDuplicates = {};
      
      for (const asset of localAssets.assets) {
        const assetInfo = await MediaLibrary.getAssetInfoAsync(asset.id);
        const filename = assetInfo.filename || asset.filename;
        const normalizedFilename = filename.toLowerCase();
        
        // Track duplicates
        if (localDuplicates[normalizedFilename]) {
          localDuplicates[normalizedFilename]++;
        } else {
          localDuplicates[normalizedFilename] = 1;
        }
        
        // Normalize to lowercase for case-insensitive comparison
        localFilenames.add(normalizedFilename);
      }
      
      const deviceDups = Object.entries(localDuplicates).filter(([_, count]) => count > 1);
      console.log(`📊 Unique filenames on device: ${localFilenames.size}`);
      if (deviceDups.length > 0) {
        console.log(`⚠️  Device has ${deviceDups.length} duplicate filenames`);
      }
      
      if (serverFiles.length === 0) {
        setStatus('No files on server to download.');
        Alert.alert('No Files', 'There are no files on the server to download.');
        setLoading(false);
        return;
      }
      
      // Only download files that don't exist locally (case-insensitive check)
      const toDownload = serverFiles.filter(f => {
        const normalizedFilename = f.filename.toLowerCase();
        const exists = localFilenames.has(normalizedFilename);
        if (exists) {
          console.log(`✓ Skipping ${f.filename} - already exists locally`);
        } else {
          console.log(`⬇️ Will download ${f.filename} - not found locally`);
        }
        return !exists;
      });
      
      console.log(`\n📊 Restore Summary:`);
      console.log(`Server: ${serverFiles.length}, Local: ${localFilenames.size}, To download: ${toDownload.length}`);
      
      if (toDownload.length === 0) {
        setStatus(`All ${serverFiles.length} files already synced.`);
        Alert.alert('Up to Date', `All ${serverFiles.length} server files are already on your device.`);
        setLoading(false);
        return;
      }

      // Show summary before starting
      setStatus(`Ready to download ${toDownload.length} of ${serverFiles.length} files...`);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Brief pause to show message

      // 3. Download Loop - download new files only
      let count = 0;
      const downloadedUris = [];
      
      for (const file of toDownload) {
        try {
          setStatus(`Downloading ${count + 1}/${toDownload.length}: ${file.filename}`);
          console.log(`Downloading: ${file.filename}`);
          
          const downloadPath = FileSystem.cacheDirectory + file.filename;
          
          // Delete cached file if it exists to prevent conflicts
          const cachedFileInfo = await FileSystem.getInfoAsync(downloadPath);
          if (cachedFileInfo.exists) {
            await FileSystem.deleteAsync(downloadPath, { idempotent: true });
            console.log(`Cleared cached file: ${file.filename}`);
          }
          
          const downloadRes = await FileSystem.downloadAsync(
            `${getServerUrl()}/api/files/${file.filename}`,
            downloadPath,
            { headers: config.headers }
          );

          if (downloadRes.status === 200) {
            const fileInfo = await FileSystem.getInfoAsync(downloadRes.uri);
            if (fileInfo.exists && fileInfo.size > 0) {
              downloadedUris.push({ uri: downloadRes.uri, filename: file.filename });
              console.log(`Downloaded ${file.filename} (${fileInfo.size} bytes)`);
            }
          }
        } catch (fileError) {
          console.error(`Error downloading ${file.filename}:`, fileError);
        }
        count++;
      }
      
      // 4. Save all downloaded files to gallery in batch
      let successCount = 0;
      if (downloadedUris.length > 0) {
        setStatus(`Saving ${downloadedUris.length} files to gallery...`);
        try {
          // Get or create PhotoSync album
          const albums = await MediaLibrary.getAlbumsAsync();
          let photoSyncAlbum = albums.find(a => a.title === 'PhotoSync');
          
          // Save files to library using saveToLibraryAsync (asks permission once)
          const assets = [];
          for (const item of downloadedUris) {
            try {
              const asset = await MediaLibrary.saveToLibraryAsync(item.uri);
              assets.push(asset);
              successCount++;
            } catch (err) {
              console.log(`Could not save ${item.filename}: ${err.message}`);
            }
          }
          
          // Add all assets to album at once
          if (assets.length > 0) {
            if (photoSyncAlbum) {
              await MediaLibrary.addAssetsToAlbumAsync(assets, photoSyncAlbum, false);
            } else {
              await MediaLibrary.createAlbumAsync('PhotoSync', assets[0], false);
              if (assets.length > 1) {
                const newAlbums = await MediaLibrary.getAlbumsAsync();
                photoSyncAlbum = newAlbums.find(a => a.title === 'PhotoSync');
                await MediaLibrary.addAssetsToAlbumAsync(assets.slice(1), photoSyncAlbum, false);
              }
            }
            console.log(`Saved ${assets.length} files to PhotoSync album`);
          }
          
          // Clean up cache files after saving to gallery
          for (const item of downloadedUris) {
            try {
              await FileSystem.deleteAsync(item.uri, { idempotent: true });
              console.log(`Cleaned up cache: ${item.filename}`);
            } catch (err) {
              console.log(`Could not delete cache file ${item.filename}: ${err.message}`);
            }
          }
        } catch (galleryError) {
          console.log(`Gallery save error: ${galleryError.message}`);
        }
      }
      
      console.log('\n📊 ===== RESTORE SUMMARY =====');
      console.log(`Server files: ${serverFiles.length}`);
      console.log(`Device assets before: ${localAssets.assets.length}`);
      console.log(`Unique filenames on device: ${localFilenames.size}`);
      console.log(`Marked for download: ${toDownload.length}`);
      console.log(`Successfully downloaded: ${successCount}`);
      console.log(`Failed downloads: ${toDownload.length - successCount}`);
      console.log('===== END RESTORE TRACE =====\n');
      
      setStatus(`Restore Complete! ${successCount}/${toDownload.length} files downloaded.`);
      setProgress(0); // Reset progress after completion
      
      if (successCount > 0) {
        Alert.alert(
          'Download Complete!', 
          `Successfully downloaded ${successCount} file${successCount > 1 ? 's' : ''}!\n\nFiles saved to gallery in "PhotoSync" album.\n\nYou can view them in your Photos app.`,
          [{ text: 'OK' }]
        );
      }

    } catch (error) {
      console.error('Restore error:', error);
      setStatus('Error during restore: ' + error.message);
      setProgress(0); // Reset progress on error
      Alert.alert('Restore Error', error.message);
    } finally {
      setLoading(false);
    }
  };

  if (view === 'loading') {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator size="large" color={THEME.primary} />
      </View>
    );
  }

  if (view === 'auth') {
    return (
      <KeyboardAvoidingView 
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
        <ScrollView 
          contentContainerStyle={{paddingBottom: 20}}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
        <View style={styles.authHeader}>
          <Image 
            source={require('./assets/icon.png')} 
            style={styles.appIcon}
          />
          <Text style={styles.title}>PhotoSync</Text>
          <Text style={styles.subtitle}>Secure Cloud Backup for Your Memories</Text>
        </View>
        
        <View style={styles.form}>
          <View style={styles.serverConfig}>
            <Text style={styles.serverLabel}>Server Type</Text>
            <View style={styles.serverToggle}>
              <TouchableOpacity 
                style={[styles.toggleBtn, serverType === 'local' && styles.toggleBtnActive]}
                onPress={() => setServerType('local')}>
                <Text style={[styles.toggleText, serverType === 'local' && styles.toggleTextActive]}>
                  Local Network
                </Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.toggleBtn, serverType === 'remote' && styles.toggleBtnActive]}
                onPress={() => setServerType('remote')}>
                <Text style={[styles.toggleText, serverType === 'remote' && styles.toggleTextActive]}>
                  Remote Server
                </Text>
              </TouchableOpacity>
            </View>
            
            {serverType === 'remote' && (
              <>
                <TextInput 
                  style={[styles.input, {marginTop: 12}]} 
                  placeholder="Enter remote domain or IP" 
                  placeholderTextColor="#666666"
                  value={remoteHost}
                  onChangeText={(t) => setRemoteHost(normalizeHostInput(t))}
                  autoCapitalize="none"
                />
                <Text style={styles.inputHint}>Example: myserver.com or 23.198.9.123 (HTTPS is used automatically)</Text>
              </>
            )}

            {serverType === 'local' && (
              <>
                <TextInput 
                  style={[styles.input, {marginTop: 12}]} 
                  placeholder="Enter local server IP" 
                  placeholderTextColor="#666666"
                  value={localHost}
                  onChangeText={(t) => setLocalHost(normalizeHostInput(t))}
                  autoCapitalize="none"
                />
                <Text style={styles.inputHint}>Example: 192.168.1.222 (port 3000 is used automatically)</Text>
              </>
            )}
            
            <Text style={styles.serverHint}>
              {serverType === 'local'
                ? '📡 Using local network (http://<your-computer-ip>:3000)'
                : '🌐 Using remote server (https://<domain-or-ip>)'}
            </Text>
          </View>
          
          <TextInput 
            style={styles.input} 
            placeholder="Email" 
            placeholderTextColor="#888888"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <TextInput 
            style={styles.input} 
            placeholder="Password" 
            placeholderTextColor="#888888"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />
          
          <TouchableOpacity style={styles.btnPrimary} onPress={() => handleAuth('login')} disabled={loading}>
            <Text style={styles.btnText}>{loading ? 'Processing...' : 'Login'}</Text>
          </TouchableOpacity>
          
          <TouchableOpacity style={styles.btnSecondary} onPress={() => handleAuth('register')} disabled={loading}>
            <Text style={styles.btnTextSec}>Create Account</Text>
          </TouchableOpacity>
        </View>
        
        <View style={styles.authFooter}>
          <Text style={styles.footerText}>🔒 End-to-end encrypted • Device-bound security</Text>
        </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  if (view === 'settings') {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setView('home')} style={styles.backBtn}>
            <Text style={styles.backText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Settings</Text>
          <View style={{width: 60}} />
        </View>
        
        <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>Server</Text>
            <Text style={styles.settingsDescription}>
              Choose where your server is running:
            </Text>
            
            <View style={styles.serverToggle}>
              <TouchableOpacity 
                style={[styles.toggleBtn, serverType === 'local' && styles.toggleBtnActive]}
                onPress={() => setServerType('local')}>
                <Text style={[styles.toggleText, serverType === 'local' && styles.toggleTextActive]}>
                  Local
                </Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.toggleBtn, serverType === 'remote' && styles.toggleBtnActive]}
                onPress={() => setServerType('remote')}>
                <Text style={[styles.toggleText, serverType === 'remote' && styles.toggleTextActive]}>
                  Remote
                </Text>
              </TouchableOpacity>
            </View>
            
            <View style={styles.serverExplanation}>
              {serverType === 'local' ? (
                <Text style={styles.serverExplanationText}>
                  📱 <Text style={styles.boldText}>Local:</Text> Server on same WiFi network{'\n'}
                  (e.g., your home computer or laptop)
                </Text>
              ) : (
                <Text style={styles.serverExplanationText}>
                  🌐 <Text style={styles.boldText}>Remote:</Text> Server anywhere on internet{'\n'}
                  (e.g., cloud server or office computer — open port 3000 externally)
                </Text>
              )}
            </View>
            
            {serverType === 'remote' && (
              <TextInput 
                style={[styles.input, {marginTop: 12}]} 
                placeholder="IP or domain of your server" 
                placeholderTextColor="#666666"
                value={remoteHost}
                onChangeText={(t) => setRemoteHost(normalizeHostInput(t))}
                autoCapitalize="none"
              />
            )}

            {serverType === 'local' && (
              <TextInput 
                style={[styles.input, {marginTop: 12}]} 
                placeholder="Local server IP" 
                placeholderTextColor="#666666"
                value={localHost}
                onChangeText={(t) => setLocalHost(normalizeHostInput(t))}
                autoCapitalize="none"
              />
            )}
            
            <View style={styles.serverInfo}>
              <Text style={styles.serverInfoLabel}>Connected to:</Text>
              <Text style={styles.serverInfoText}>{getServerUrl()}</Text>
            </View>
            
            <TouchableOpacity 
              style={styles.btnPrimary} 
              onPress={async () => {
                await SecureStore.setItemAsync('server_type', serverType);
                if (serverType === 'remote') {
                  await SecureStore.setItemAsync('remote_host', remoteHost);
                } else {
                  await SecureStore.setItemAsync('local_host', localHost);
                }
                Alert.alert('Saved', 'Server settings updated');
                setView('home');
              }}>
              <Text style={styles.btnText}>Save Changes</Text>
            </TouchableOpacity>
          </View>
          
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>� Server Setup</Text>
            <Text style={styles.serverExplanationText}>
              Follow the latest install steps on GitHub.
            </Text>
            <TouchableOpacity 
              style={styles.setupGuideBtn}
              onPress={() => openLink('https://github.com/viktorvishyn369/PhotoSync#-quick-start')}>
              <Text style={styles.setupGuideBtnText}>Open README Instructions</Text>
            </TouchableOpacity>
            <Text style={styles.serverExplanationText}>
              Includes prerequisites, one-line install, and troubleshooting.
            </Text>
          </View>
          
          <View style={styles.settingsFooter}>
            <Text style={styles.footerVersion}>PhotoSync v1.0.0</Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (view === 'about') {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setView('home')} style={styles.backBtn}>
            <Text style={styles.backText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>About</Text>
          <View style={{width: 60}} />
        </View>
        
        <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>PhotoSync</Text>
            {deviceUuid && (
              <TouchableOpacity 
                style={styles.uuidBox}
                onPress={() => {
                  Clipboard.setString(deviceUuid);
                  Alert.alert('Copied!', 'Device ID copied to clipboard');
                }}>
                <Text style={styles.uuidLabel}>Device ID (tap to copy):</Text>
                <Text style={styles.uuidText}>{deviceUuid}</Text>
              </TouchableOpacity>
            )}
          </View>
          
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>Resources</Text>
            
            <TouchableOpacity 
              style={styles.resourceBtn}
              onPress={() => {
                const githubUrl = 'https://github.com/viktorvishyn369/PhotoSync';
                Linking.openURL(githubUrl).catch(err => {
                  Alert.alert('Error', 'Could not open link');
                });
              }}>
              <Text style={styles.resourceIcon}>📦</Text>
              <View style={styles.resourceContent}>
                <Text style={styles.resourceTitle}>GitHub</Text>
                <Text style={styles.resourceDesc}>Download server & docs</Text>
              </View>
              <Text style={styles.resourceArrow}>→</Text>
            </TouchableOpacity>
            
            <View style={styles.openSourceBadge}>
              <Text style={styles.openSourceText}>
                ⭐ Open Source • Self-Hosted • Privacy First
              </Text>
            </View>
          </View>
          
          <View style={styles.settingsFooter}>
            <Text style={styles.footerVersion}>PhotoSync v1.0.0</Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>PhotoSync</Text>
          <Text style={styles.headerSubtitle}>Your Secure Backup</Text>
        </View>
        <View style={styles.headerButtons}>
          <TouchableOpacity onPress={() => setView('about')} style={styles.infoBtn}>
            <Text style={styles.infoText}>i</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setView('settings')} style={styles.settingsBtn}>
            <Text style={styles.settingsText}>⚙️</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={logout} style={styles.logoutBtn}>
            <Text style={styles.logoutText}>Logout</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        <View style={styles.statusCard}>
          <View style={styles.statusHeader}>
            <Text style={styles.statusLabel}>STATUS</Text>
          </View>
          <Text style={styles.statusText}>{status}</Text>
          {progress > 0 && progress < 1 && (
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
            </View>
          )}
        </View>

        <View style={styles.actionsContainer}>
          <TouchableOpacity 
            onPress={backupPhotos} 
            disabled={loading}
            style={[styles.actionCard, styles.backupCard, loading && styles.disabledCard]}>
            <View style={styles.cardIcon}>
              <Text style={styles.cardIconText}>☁️</Text>
            </View>
            <Text style={styles.cardTitle}>Backup Photos</Text>
            <Text style={styles.cardDescription}>Upload your photos/videos to secure cloud storage</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            onPress={restorePhotos} 
            onLongPress={async () => {
              await SecureStore.deleteItemAsync('downloaded_files');
              Alert.alert('Reset', 'Download history cleared. All files will be re-downloaded.');
            }}
            disabled={loading}
            style={[styles.actionCard, styles.syncCard, loading && styles.disabledCard]}>
            <View style={styles.cardIcon}>
              <Text style={styles.cardIconText}>📥</Text>
            </View>
            <Text style={styles.cardTitle}>Sync from Cloud</Text>
            <Text style={styles.cardDescription}>Download backed up files to PhotoSync album</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            onPress={cleanDeviceDuplicates} 
            disabled={loading}
            style={[styles.actionCard, styles.cleanupCard, loading && styles.disabledCard]}>
            <View style={styles.cardIcon}>
              <Text style={styles.cardIconText}> </Text>
            </View>
            <Text style={styles.cardTitle}>Clean Duplicates</Text>
            <Text style={styles.cardDescription}>Remove duplicate photos/videos on this device</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
  }

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    paddingTop: Platform.OS === 'ios' ? 0 : 0, // SafeAreaView handles this
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Auth Screen
  authHeader: {
    alignItems: 'center',
    marginTop: Math.max(40, SCREEN_HEIGHT * 0.08),
    marginBottom: Math.max(30, SCREEN_HEIGHT * 0.04),
  },
  appIcon: {
    width: Math.min(100, SCREEN_WIDTH * 0.25),
    height: Math.min(100, SCREEN_WIDTH * 0.25),
    borderRadius: 20,
    marginBottom: 16,
  },
  title: {
    fontSize: Math.min(32, SCREEN_WIDTH * 0.08),
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#AAAAAA',
    textAlign: 'center',
    paddingHorizontal: 30,
  },
  form: {
    paddingHorizontal: Math.max(20, SCREEN_WIDTH * 0.05),
    gap: 12,
    maxWidth: 500,
    width: '100%',
    alignSelf: 'center',
    marginBottom: 20,
  },
  input: {
    backgroundColor: '#1A1A1A',
    color: '#FFFFFF',
    padding: 18,
    borderRadius: 12,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#333333',
  },
  btnPrimary: {
    backgroundColor: '#BB86FC',
    padding: 18,
    borderRadius: 12,
    alignItems: 'center',
    width: '100%',
    marginTop: 10,
  },
  btnSecondary: {
    padding: 18,
    alignItems: 'center',
  },
  btnText: {
    color: '#000000',
    fontWeight: 'bold',
    fontSize: 16,
  },
  btnTextSec: {
    color: '#AAAAAA',
    fontSize: 16,
  },
  authFooter: {
    alignItems: 'center',
    paddingVertical: 20,
    paddingBottom: 40,
  },
  footerText: {
    color: '#666666',
    fontSize: 12,
  },
  // Main Screen
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 20,
    backgroundColor: '#0A0A0A',
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  headerSubtitle: {
    fontSize: 14,
    color: '#888888',
    marginTop: 2,
  },
  logoutBtn: {
    backgroundColor: '#1A1A1A',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  logoutText: {
    color: '#FF6B6B',
    fontSize: 14,
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: Math.max(16, SCREEN_WIDTH * 0.04),
    maxWidth: 600,
    width: '100%',
    alignSelf: 'center',
  },
  statusCard: {
    backgroundColor: '#1A1A1A',
    padding: 20,
    borderRadius: 16,
    marginBottom: 30,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  statusHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  statusLabel: {
    color: '#03DAC6',
    fontWeight: 'bold',
    fontSize: 12,
    letterSpacing: 2,
  },
  statusText: {
    color: '#FFFFFF',
    fontSize: 16,
  },
  progressBar: {
    height: 4,
    backgroundColor: '#2A2A2A',
    borderRadius: 2,
    marginTop: 12,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#03DAC6',
  },
  actionsContainer: {
    gap: 15,
    marginBottom: 20,
  },
  actionCard: {
    padding: 24,
    borderRadius: 16,
    borderWidth: 2,
  },
  backupCard: {
    backgroundColor: '#2A1A3A',
    borderColor: '#BB86FC',
  },
  syncCard: {
    backgroundColor: '#0A2A2A',
    borderColor: '#03DAC6',
  },
  cleanupCard: {
    backgroundColor: '#2A240A',
    borderColor: '#FFB74D',
  },
  disabledCard: {
    opacity: 0.5,
  },
  cardIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  cardIconText: {
    fontSize: 30,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  cardDescription: {
    fontSize: Platform.select({
      ios: SCREEN_WIDTH < 380 ? 12 : 13,
      android: SCREEN_WIDTH < 380 ? 12 : 13,
      default: SCREEN_WIDTH < 380 ? 12 : 13,
    }),
    color: '#AAAAAA',
    lineHeight: SCREEN_WIDTH < 380 ? 17 : 18,
  },
  infoCard: {
    backgroundColor: '#1A1A1A',
    padding: 16,
    borderRadius: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#03DAC6',
  },
  infoText: {
    color: '#AAAAAA',
    fontSize: 13,
  },
  // Server configuration
  serverConfig: {
    marginBottom: 20,
  },
  serverLabel: {
    color: '#AAAAAA',
    fontSize: 12,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  serverToggle: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  serverExplanation: {
    marginTop: 12,
    padding: 12,
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: THEME.primary,
  },
  serverExplanationText: {
    color: '#CCCCCC',
    fontSize: 13,
    lineHeight: 20,
  },
  toggleBtn: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#1A1A1A',
    borderWidth: 2,
    borderColor: '#333333',
    alignItems: 'center',
  },
  toggleBtnActive: {
    backgroundColor: '#5E35B1',
    borderColor: '#BB86FC',
  },
  toggleText: {
    color: '#888888',
    fontSize: 14,
    fontWeight: '600',
  },
  toggleTextActive: {
    color: '#FFFFFF',
  },
  serverHint: {
    color: '#666666',
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center',
  },
  // Settings screen
  settingsCard: {
    backgroundColor: '#1A1A1A',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  settingsTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  settingsDescription: {
    fontSize: 14,
    color: '#AAAAAA',
    marginBottom: 16,
  },
  uuidBox: {
    backgroundColor: '#0A0A0A',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  uuidLabel: {
    fontSize: 11,
    color: '#888888',
    marginBottom: 6,
  },
  uuidText: {
    fontSize: 11,
    color: '#03DAC6',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  inputLabel: {
    color: '#AAAAAA',
    fontSize: 14,
    marginBottom: 8,
    marginTop: 16,
  },
  inputHint: {
    color: '#666666',
    fontSize: 12,
    marginTop: 6,
    fontStyle: 'italic',
  },
  serverInfo: {
    marginTop: 16,
    padding: 12,
    backgroundColor: '#0A0A0A',
    borderRadius: 8,
  },
  serverInfoLabel: {
    color: '#888888',
    fontSize: 11,
    marginBottom: 4,
  },
  serverInfoText: {
    color: '#03DAC6',
    fontSize: 13,
    fontWeight: '500',
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  infoBtn: {
    backgroundColor: '#1A1A1A',
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#03DAC6',
  },
  infoText: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#03DAC6',
  },
  settingsBtn: {
    backgroundColor: '#1A1A1A',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  settingsText: {
    fontSize: 20,
  },
  backBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  backText: {
    color: '#03DAC6',
    fontSize: 16,
  },
  // Setup Guide
  guideSteps: {
    marginTop: 16,
    gap: 12,
  },
  guideStep: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  stepNumber: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#5E35B1',
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center',
    lineHeight: 32,
  },
  stepContent: {
    flex: 1,
  },
  stepTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  stepText: {
    color: '#AAAAAA',
    fontSize: 14,
    lineHeight: 20,
  },
  // How It Works
  howItWorksText: {
    color: '#CCCCCC',
    fontSize: 14,
    lineHeight: 22,
    marginTop: 12,
  },
  boldText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  setupGuideBtn: {
    backgroundColor: THEME.primary,
    padding: 18,
    borderRadius: 12,
    alignItems: 'center',
    width: '100%',
    marginBottom: 12,
  },
  setupGuideBtnText: {
    color: '#000000',
    fontSize: 15,
    fontWeight: '600',
  },
  quickStepsTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  quickStepsText: {
    color: '#CCCCCC',
    fontSize: 13,
    lineHeight: 22,
  },
  linkList: {
    gap: 8,
    marginTop: 8,
  },
  linkButton: {
    backgroundColor: '#2A2A2A',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3A3A3A',
  },
  linkButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  codeLine: {
    color: '#FFFFFF',
    fontSize: 12,
    backgroundColor: '#1A1A1A',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    marginTop: 2,
  },
  codeHint: {
    color: '#888888',
    fontSize: 11,
    marginTop: 2,
  },
  // Server Setup Guide
  guideSteps: {
    marginTop: 16,
    gap: 16,
  },
  guideStep: {
    flexDirection: 'row',
    gap: 12,
  },
  guideStepNumber: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: THEME.primary,
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center',
    lineHeight: 32,
  },
  guideStepContent: {
    flex: 1,
  },
  guideStepTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  guideStepDesc: {
    color: '#AAAAAA',
    fontSize: 13,
    lineHeight: 18,
  },
  copyLinkBtn: {
    backgroundColor: THEME.primary,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  copyLinkText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  // Resources
  resourceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#333333',
  },
  resourceIcon: {
    fontSize: 28,
    marginRight: 12,
  },
  resourceContent: {
    flex: 1,
  },
  resourceTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  resourceDesc: {
    color: '#AAAAAA',
    fontSize: 13,
  },
  resourceArrow: {
    color: '#5E35B1',
    fontSize: 20,
    fontWeight: 'bold',
  },
  openSourceBadge: {
    backgroundColor: '#1A1A1A',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#5E35B1',
    marginTop: 8,
  },
  openSourceText: {
    color: '#BB86FC',
    fontSize: 13,
    textAlign: 'center',
    fontWeight: '600',
  },
  // Settings Footer
  settingsFooter: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 8,
  },
  footerVersion: {
    color: '#666666',
    fontSize: 13,
  },
  footerCopyright: {
    color: '#666666',
    fontSize: 12,
  },
});
