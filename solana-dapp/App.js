import 'react-native-get-random-values';
import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, Alert, ScrollView, ActivityIndicator, Platform, Pressable, Button, Dimensions, SafeAreaView, KeyboardAvoidingView } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy'; // Fixed: Use legacy import for downloadAsync support
import * as SecureStore from 'expo-secure-store';
import * as Application from 'expo-application';
import { v4 as uuidv4 } from 'uuid';
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
  const [remoteIp, setRemoteIp] = useState('');
  const [token, setToken] = useState(null);
  const [status, setStatus] = useState('Idle');
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    checkLogin();
  }, []);

  const getDeviceUUID = async () => {
    let uuid = await SecureStore.getItemAsync('device_uuid');
    if (!uuid) {
      if (Platform.OS === 'android') {
        uuid = Application.androidId;
      } else if (Platform.OS === 'ios') {
        uuid = await Application.getIosIdForVendorAsync();
      }
      
      // Fallback or if above returns null
      if (!uuid) {
        uuid = uuidv4();
      }
      await SecureStore.setItemAsync('device_uuid', uuid);
    }
    return uuid;
  };

  const getServerUrl = () => {
    const PORT = '3000';
    if (serverType === 'local') {
      // Use local network IP - you can detect this or use a standard one
      return `http://192.168.1.222:${PORT}`; // Default local IP
    } else {
      return `http://${remoteIp}:${PORT}`;
    }
  };

  const checkLogin = async () => {
    // Load server settings
    const savedType = await SecureStore.getItemAsync('server_type');
    const savedRemoteIp = await SecureStore.getItemAsync('remote_ip');
    if (savedType) setServerType(savedType);
    if (savedRemoteIp) setRemoteIp(savedRemoteIp);
    
    const storedToken = await SecureStore.getItemAsync('auth_token');
    if (storedToken) {
      setToken(storedToken);
      setView('home');
    } else {
      setView('auth');
    }
  };

  const handleAuth = async (type) => {
    setLoading(true);
    try {
      // Save server settings
      await SecureStore.setItemAsync('server_type', serverType);
      if (serverType === 'remote') {
        await SecureStore.setItemAsync('remote_ip', remoteIp);
      }
      
      const deviceId = await getDeviceUUID();
      const endpoint = type === 'register' ? '/api/register' : '/api/login';
      const SERVER_URL = getServerUrl();
      
      const payload = {
        email, 
        password,
        device_uuid: deviceId,
        device_name: Platform.OS + ' ' + Platform.Version
      };

      console.log('Attempting auth:', type, `${SERVER_URL}${endpoint}`, payload);

      const res = await axios.post(`${SERVER_URL}${endpoint}`, payload, { timeout: 5000 });
      console.log('Auth response:', res.status);

      if (type === 'login') {
        const { token } = res.data;
        await SecureStore.setItemAsync('auth_token', token);
        setToken(token);
        setView('home');
      } else {
        Alert.alert('Success', 'Account created! Please login.');
      }
    } catch (error) {
      console.error('Auth Error:', error.toJSON ? error.toJSON() : error);
      Alert.alert('Error', error.response?.data?.error || error.message || 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    await SecureStore.deleteItemAsync('auth_token');
    setToken(null);
    setView('auth');
  };

  const getAuthHeaders = async () => {
    const uuid = await getDeviceUUID();
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
      // 1. Get ALL photos/videos from gallery (excluding PhotoSync folder to prevent backing up synced files)
      const albums = await MediaLibrary.getAlbumsAsync();
      console.log('All albums:', albums.map(a => `${a.title} (${a.assetCount})`).join(', '));
      
      const photoSyncAlbum = albums.find(a => a.title === 'PhotoSync');
      
      // Get ALL assets from device
      const allAssets = await MediaLibrary.getAssetsAsync({
        mediaType: ['photo', 'video'],
        first: 10000, 
        sortBy: ['creationTime']
      });
      
      console.log(`Total assets on device: ${allAssets.totalCount}`);
      
      // Exclude files from PhotoSync album (to avoid backing up synced files)
      let excludedIds = new Set();
      if (photoSyncAlbum) {
        const photoSyncAssets = await MediaLibrary.getAssetsAsync({
          album: photoSyncAlbum,
          first: 10000
        });
        photoSyncAssets.assets.forEach(a => excludedIds.add(a.id));
        console.log(`Excluding ${excludedIds.size} files from PhotoSync album`);
      }
      
      const assets = {
        ...allAssets,
        assets: allAssets.assets.filter(a => !excludedIds.has(a.id))
      };
      
      console.log(`Assets to backup: ${assets.assets.length}`);

      if (assets.assets.length === 0) {
        setStatus('No photos found to backup.');
        Alert.alert('No Photos', 'No photos or videos found on device.');
        setLoading(false);
        return;
      }

      // 2. Get Server List
      const config = await getAuthHeaders();
      const SERVER_URL = getServerUrl();
      const serverRes = await axios.get(`${SERVER_URL}/api/files`, config);
      const serverFiles = new Set(serverRes.data.files.map(f => f.filename));
      
      console.log('Server files:', Array.from(serverFiles));
      console.log('Local assets:', assets.assets.map(a => a.filename));

      // 3. Identify Missing on Server
      const toUpload = assets.assets.filter(asset => {
        const exists = serverFiles.has(asset.filename);
        console.log(`Checking ${asset.filename}: ${exists ? 'EXISTS on server' : 'MISSING from server'}`);
        return !exists;
      });
      
      console.log(`Need to upload ${toUpload.length} files`);
      
      if (toUpload.length === 0) {
        setStatus('All files already backed up.');
        setLoading(false);
        return;
      }

      // 4. Upload Loop
      let count = 0;
      for (const asset of toUpload) {
        setStatus(`Uploading ${count + 1}/${toUpload.length}: ${asset.filename}`);
        
        // Get file info
        const assetInfo = await MediaLibrary.getAssetInfoAsync(asset.id);
        // On iOS, localUri might be needed. On Android uri is usually file://
        const localUri = assetInfo.localUri || assetInfo.uri;

        if (!localUri) continue;

        const formData = new FormData();
        formData.append('file', {
          uri: localUri,
          name: asset.filename,
          type: asset.mediaType === 'video' ? 'video/mp4' : 'image/jpeg', // Simplified mime type guessing
        });

        // Axios upload
        await axios.post(`${SERVER_URL}/api/upload`, formData, {
            headers: {
                'Content-Type': 'multipart/form-data',
                ...config.headers
            }
        });
        count++;
        setProgress(count / toUpload.length);
      }

      setStatus(`Backup Complete! Uploaded ${count} file${count !== 1 ? 's' : ''}.`);
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
    
    setStatus('Checking server files...');
    setProgress(0); // Reset progress

    try {
      // 1. Get Server Files
      const config = await getAuthHeaders();
      const serverRes = await axios.get(`${getServerUrl()}/api/files`, config);
      const serverFiles = serverRes.data.files;
      console.log(`Found ${serverFiles.length} files on server`);

      // 2. Check which files we've already downloaded
      const downloadedFilesJson = await SecureStore.getItemAsync('downloaded_files');
      const downloadedFiles = downloadedFilesJson ? JSON.parse(downloadedFilesJson) : [];
      
      // Clean up tracking - only keep files that exist on server
      const serverFilenames = new Set(serverFiles.map(f => f.filename));
      const cleanedDownloads = downloadedFiles.filter(f => serverFilenames.has(f));
      
      // Save cleaned tracking
      if (cleanedDownloads.length !== downloadedFiles.length) {
        await SecureStore.setItemAsync('downloaded_files', JSON.stringify(cleanedDownloads));
        console.log(`Cleaned tracking: ${downloadedFiles.length} -> ${cleanedDownloads.length}`);
      }
      
      const downloadedSet = new Set(cleanedDownloads);
      console.log(`Server has ${serverFiles.length} files, already downloaded ${cleanedDownloads.length}`);
      
      if (serverFiles.length === 0) {
        setStatus('No files on server to download.');
        Alert.alert('No Files', 'There are no files on the server to download.');
        setLoading(false);
        return;
      }
      
      // Only download files we haven't downloaded before
      const toDownload = serverFiles.filter(f => !downloadedSet.has(f.filename));
      
      if (toDownload.length === 0) {
        setStatus('All files already synced.');
        Alert.alert('Up to Date', 'All server files are already on your device.');
        setLoading(false);
        return;
      }

      // 3. Download Loop - download new files only
      let count = 0;
      const downloadedUris = [];
      const newDownloads = []; // Track only new downloads
      
      for (const file of toDownload) {
        try {
          setStatus(`Downloading ${count + 1}/${toDownload.length}: ${file.filename}`);
          console.log(`Downloading: ${file.filename}`);
          
          const downloadPath = FileSystem.cacheDirectory + file.filename;
          const downloadRes = await FileSystem.downloadAsync(
            `${SERVER_URL}/api/files/${file.filename}`,
            downloadPath,
            { headers: config.headers }
          );

          if (downloadRes.status === 200) {
            const fileInfo = await FileSystem.getInfoAsync(downloadRes.uri);
            if (fileInfo.exists && fileInfo.size > 0) {
              downloadedUris.push({ uri: downloadRes.uri, filename: file.filename });
              newDownloads.push(file.filename);
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
        } catch (galleryError) {
          console.log(`Gallery save error: ${galleryError.message}`);
        }
      }
      // Save updated download tracking - merge cleaned old and new
      const allDownloaded = [...cleanedDownloads, ...newDownloads];
      await SecureStore.setItemAsync('downloaded_files', JSON.stringify(allDownloaded));
      console.log('Updated downloaded files tracking:', allDownloaded);
      
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
        <ScrollView contentContainerStyle={{flexGrow: 1}}>
        <View style={styles.authHeader}>
          <View style={styles.iconCircle}>
            <Text style={styles.iconText}>🔐</Text>
          </View>
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
                  placeholder="Enter server IP or domain" 
                  placeholderTextColor="#666666"
                  value={remoteIp}
                  onChangeText={setRemoteIp}
                  autoCapitalize="none"
                />
                <Text style={styles.inputHint}>Example: 123.45.67.89 or myserver.com</Text>
              </>
            )}
            
            <Text style={styles.serverHint}>
              {serverType === 'local' ? '📡 Using local network (192.168.1.222:3000)' : '🌐 Port 3000 (hardcoded)'}
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
            <Text style={styles.settingsTitle}>Server Configuration</Text>
            <Text style={styles.settingsDescription}>Configure your PhotoSync server connection (Port 3000)</Text>
            
            <Text style={styles.inputLabel}>Server Type</Text>
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
                <Text style={styles.inputLabel}>Remote Server IP/Domain</Text>
                <TextInput 
                  style={styles.input} 
                  placeholder="example.com or 123.456.789.0" 
                  placeholderTextColor="#888888"
                  value={remoteIp}
                  onChangeText={setRemoteIp}
                  autoCapitalize="none"
                />
              </>
            )}
            
            <TouchableOpacity 
              style={styles.btnPrimary} 
              onPress={async () => {
                await SecureStore.setItemAsync('server_type', serverType);
                if (serverType === 'remote') {
                  await SecureStore.setItemAsync('remote_ip', remoteIp);
                }
                Alert.alert('Saved', `Server set to ${getServerUrl()}`);
                setView('home');
              }}>
              <Text style={styles.btnText}>Save Settings</Text>
            </TouchableOpacity>
            
            <View style={styles.serverInfo}>
              <Text style={styles.serverInfoText}>Current: {getServerUrl()}</Text>
            </View>
          </View>
          
          {/* Setup Guide */}
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>📖 Quick Setup Guide</Text>
            <Text style={styles.settingsDescription}>Follow these simple steps to get started:</Text>
            
            <View style={styles.guideSteps}>
              <View style={styles.guideStep}>
                <Text style={styles.stepNumber}>1</Text>
                <View style={styles.stepContent}>
                  <Text style={styles.stepTitle}>Download Server</Text>
                  <Text style={styles.stepText}>Get the PhotoSync server from GitHub</Text>
                </View>
              </View>
              
              <View style={styles.guideStep}>
                <Text style={styles.stepNumber}>2</Text>
                <View style={styles.stepContent}>
                  <Text style={styles.stepTitle}>Run Server</Text>
                  <Text style={styles.stepText}>Install and start the server on your computer</Text>
                </View>
              </View>
              
              <View style={styles.guideStep}>
                <Text style={styles.stepNumber}>3</Text>
                <View style={styles.stepContent}>
                  <Text style={styles.stepTitle}>Configure & Sync</Text>
                  <Text style={styles.stepText}>Set server IP above, register, and start backing up!</Text>
                </View>
              </View>
            </View>
          </View>
          
          {/* How It Works */}
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>💡 How It Works</Text>
            <Text style={styles.howItWorksText}>
              PhotoSync is a self-hosted photo backup solution. Your photos are stored on YOUR server, giving you complete control and privacy.
              {'\n\n'}
              • <Text style={styles.boldText}>Backup:</Text> Upload photos/videos to your server
              {'\n'}
              • <Text style={styles.boldText}>Restore:</Text> Download files back to your device
              {'\n'}
              • <Text style={styles.boldText}>Privacy:</Text> Your data never leaves your control
              {'\n'}
              • <Text style={styles.boldText}>Security:</Text> Device-bound authentication
              {'\n\n'}
              📁 <Text style={styles.boldText}>Uploaded Files Location:</Text>
              {'\n'}
              Your synced photos are stored in the <Text style={styles.boldText}>uploads/</Text> folder on your server (relative to where you installed it).
            </Text>
          </View>
          
          {/* GitHub & Resources */}
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>🔗 Resources</Text>
            
            <TouchableOpacity 
              style={styles.resourceBtn}
              onPress={() => {
                // Open GitHub repository
                const githubUrl = 'https://github.com/viktorvishyn369/PhotoSync';
                Alert.alert(
                  'Open Source Project',
                  'PhotoSync is open source!\n\nGitHub: ' + githubUrl + '\n\nDownload the server app and view the source code.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { 
                      text: 'Open GitHub', 
                      onPress: () => {
                        // In a real app, use Linking.openURL(githubUrl)
                        console.log('Opening:', githubUrl);
                      }
                    }
                  ]
                );
              }}>
              <Text style={styles.resourceIcon}>📦</Text>
              <View style={styles.resourceContent}>
                <Text style={styles.resourceTitle}>GitHub Repository</Text>
                <Text style={styles.resourceDesc}>Download server app & view source code</Text>
              </View>
              <Text style={styles.resourceArrow}>→</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={styles.resourceBtn}
              onPress={() => {
                Alert.alert(
                  'Server Requirements',
                  'To run the PhotoSync server:\n\n' +
                  '• Node.js 16 or higher\n' +
                  '• 100MB+ free disk space\n' +
                  '• Windows, Mac, or Linux\n\n' +
                  'Download from GitHub and run:\n' +
                  'npm install && npm start',
                  [{ text: 'Got it!' }]
                );
              }}>
              <Text style={styles.resourceIcon}>💻</Text>
              <View style={styles.resourceContent}>
                <Text style={styles.resourceTitle}>Server Requirements</Text>
                <Text style={styles.resourceDesc}>What you need to run the server</Text>
              </View>
              <Text style={styles.resourceArrow}>→</Text>
            </TouchableOpacity>
            
            <View style={styles.openSourceBadge}>
              <Text style={styles.openSourceText}>
                ⭐ 100% Open Source • Self-Hosted • Privacy First
              </Text>
            </View>
          </View>
          
          <View style={styles.settingsFooter}>
            <Text style={styles.footerVersion}>PhotoSync v1.0.0</Text>
            <Text style={styles.footerCopyright}>Open Source • Made with ❤️</Text>
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
            {loading && <ActivityIndicator size="small" color="#03DAC6" />}
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
            <Text style={styles.cardDescription}>Upload your photos & videos to secure cloud storage</Text>
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
    marginTop: 80,
    marginBottom: 60,
  },
  iconCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#5E35B1',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 30,
  },
  iconText: {
    fontSize: 50,
  },
  title: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    color: '#AAAAAA',
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  form: {
    paddingHorizontal: Math.max(20, SCREEN_WIDTH * 0.05),
    gap: 15,
    maxWidth: 500,
    width: '100%',
    alignSelf: 'center',
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
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: 'center',
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
    fontSize: 14,
    color: '#AAAAAA',
    lineHeight: 20,
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
    marginBottom: 8,
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
    padding: 24,
    borderRadius: 16,
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
    marginBottom: 24,
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
    marginTop: 20,
    padding: 12,
    backgroundColor: '#0A0A0A',
    borderRadius: 8,
  },
  serverInfoText: {
    color: '#03DAC6',
    fontSize: 12,
    textAlign: 'center',
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 10,
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
