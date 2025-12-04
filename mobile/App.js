import 'react-native-get-random-values';
import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, Alert, ScrollView, ActivityIndicator, Platform, Pressable, Button } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as Application from 'expo-application';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

// CONFIGURATION
// Use 'http://10.0.2.2:3000' for Android Emulator
// Use your LAN IP (e.g. 'http://192.168.1.222:3000') for Physical Device
const SERVER_URL = 'http://10.0.2.2:3000'; 
// const SERVER_URL = 'http://192.168.1.222:3000'; 

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
  const [view, setView] = useState('loading'); // loading, auth, home
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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

  const checkLogin = async () => {
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
      const deviceId = await getDeviceUUID();
      const githubUrl = 'https://github.com/viktorvishyn369/PhotoSync';
      const endpoint = type === 'register' ? '/api/register' : '/api/login';
      
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
    console.log('Permission status:', status);
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'We need access to photos to back them up.');
      return;
    }

    setStatus('Scanning local media...');
    setLoading(true);

    try {
      // 1. Get Local Assets
      const assets = await MediaLibrary.getAssetsAsync({
        mediaType: ['photo', 'video'],
        first: 1000, 
        sortBy: ['creationTime']
      });
      
      console.log(`Found ${assets.totalCount} assets.`);

      if (assets.totalCount === 0) {
        setStatus('No photos found on device.');
        Alert.alert('No Photos', 'Please take a photo with your camera first, or add some images to the gallery.');
        setLoading(false);
        return;
      }

      // 2. Get Server List
      const config = await getAuthHeaders();
      const serverRes = await axios.get(`${SERVER_URL}/api/files`, config);
      const serverFiles = new Set(serverRes.data.files.map(f => f.filename));

      // 3. Identify Missing on Server
      const toUpload = assets.assets.filter(asset => !serverFiles.has(asset.filename));
      
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

      setStatus('Backup Complete!');
    } catch (error) {
      console.error(error);
      setStatus('Error during backup: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const restorePhotos = async () => {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status !== 'granted') return;

    setStatus('Checking server files...');
    setLoading(true);

    try {
      // 1. Get Server Files
      const config = await getAuthHeaders();
      const serverRes = await axios.get(`${SERVER_URL}/api/files`, config);
      const serverFiles = serverRes.data.files;

      // 2. Get Local Files (to avoid duplicates)
      // This is tricky without exact filename matching, assuming filename uniqueness
      const assets = await MediaLibrary.getAssetsAsync({ first: 1000 });
      const localFilenames = new Set(assets.assets.map(a => a.filename));

      const toDownload = serverFiles.filter(f => !localFilenames.has(f.filename));

      if (toDownload.length === 0) {
        setStatus('Device is up to date.');
        setLoading(false);
        return;
      }

      // 3. Download Loop
      let count = 0;
      for (const file of toDownload) {
        setStatus(`Downloading ${count + 1}/${toDownload.length}: ${file.filename}`);
        
        const downloadRes = await FileSystem.downloadAsync(
          `${SERVER_URL}/api/files/${file.filename}`,
          FileSystem.documentDirectory + file.filename,
          { headers: config.headers }
        );

        if (downloadRes.status === 200) {
           await MediaLibrary.createAssetAsync(downloadRes.uri);
        }
        
        count++;
      }
      setStatus('Restore Complete!');

    } catch (error) {
      setStatus('Error during restore');
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
      <View style={styles.container}>
        <Text style={styles.title}>VaultSync</Text>
        <Text style={styles.subtitle}>Secure Cloud Backup</Text>
        
        <View style={styles.form}>
          <TextInput 
            style={styles.input} 
            placeholder="Email" 
            placeholderTextColor={THEME.textSec}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
          />
          <TextInput 
            style={styles.input} 
            placeholder="Password" 
            placeholderTextColor={THEME.textSec}
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
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>My Vault v2</Text>
        <TouchableOpacity onPress={logout}>
           <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.content}>
        <View style={styles.statusCard}>
            <Text style={styles.statusLabel}>STATUS</Text>
            <Text style={styles.statusText}>{status}</Text>
            {loading && <ActivityIndicator style={{marginTop: 10}} color={THEME.primary} />}
        </View>

        <View style={styles.actions}>
            <Pressable style={styles.actionBtn} onPress={backupPhotos} disabled={loading}>
                  <Text style={{color: 'white', fontSize: 18, fontWeight: 'bold'}}>Backup to Cloud</Text>
                  <Text style={{color: '#AAAAAA', fontSize: 14, marginTop: 5}}>Upload missing photos/videos</Text>
            </Pressable>

            <Pressable style={[styles.actionBtn, { marginTop: 15 }]} onPress={restorePhotos} disabled={loading}>
                  <Text style={{color: 'white', fontSize: 18, fontWeight: 'bold'}}>Sync to Device</Text>
                  <Text style={{color: '#AAAAAA', fontSize: 14, marginTop: 5}}>Download missing files</Text>
            </Pressable>

            <View style={{marginTop: 30}}>
              <Button title="Backup (Native Button)" onPress={backupPhotos} />
              <View style={{height: 10}} />
              <Button title="Sync (Native Button)" onPress={restorePhotos} />
            </View>

            {/* Info Section */}
            <View style={styles.infoCard}>
              <Text style={styles.infoTitle}>ℹ️ About PhotoSync</Text>
              <Text style={styles.infoText}>
                Self-hosted photo backup. Your photos are stored on YOUR server.{'\n\n'}
                📁 <Text style={styles.boldText}>Server Location:</Text>{'\n'}
                Files are stored in the <Text style={styles.boldText}>uploads/</Text> folder (relative to your server installation).{'\n\n'}
                🔗 <Text style={styles.boldText}>Open Source:</Text>{'\n'}
                GitHub: github.com/viktorvishyn369/PhotoSync
              </Text>
            </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.bg,
    padding: 20,
    paddingTop: 60,
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: THEME.text,
    textAlign: 'center',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    color: THEME.textSec,
    textAlign: 'center',
    marginBottom: 50,
  },
  form: {
    gap: 15,
  },
  input: {
    backgroundColor: THEME.card,
    color: THEME.text,
    padding: 15,
    borderRadius: 8,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  btnPrimary: {
    backgroundColor: THEME.primary,
    padding: 15,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 10,
  },
  btnSecondary: {
    padding: 15,
    alignItems: 'center',
  },
  btnText: {
    color: '#000',
    fontWeight: 'bold',
    fontSize: 16,
  },
  btnTextSec: {
    color: THEME.textSec,
    fontSize: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 40,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: THEME.text,
  },
  logoutText: {
    color: THEME.error,
    fontSize: 16,
  },
  statusCard: {
    backgroundColor: THEME.card,
    padding: 20,
    borderRadius: 12,
    marginBottom: 30,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  statusLabel: {
    color: THEME.secondary,
    fontWeight: 'bold',
    fontSize: 12,
    letterSpacing: 2,
    marginBottom: 10,
  },
  statusText: {
    color: THEME.text,
    fontSize: 16,
    textAlign: 'center',
  },
  actions: {
    flex: 1,
  },
  actionBtn: {
    backgroundColor: '#2C2C2C',
    padding: 20,
    borderRadius: 12,
    borderLeftWidth: 4,
    borderLeftColor: THEME.primary,
  },
  actionBtnTitle: {
    color: THEME.text,
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 5,
  },
  actionBtnDesc: {
    color: THEME.textSec,
    fontSize: 14,
  },
  infoCard: {
    backgroundColor: THEME.card,
    padding: 15,
    borderRadius: 12,
    marginTop: 20,
    borderWidth: 1,
    borderColor: '#333',
  },
  infoTitle: {
    color: THEME.text,
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  infoText: {
    color: THEME.textSec,
    fontSize: 13,
    lineHeight: 20,
  },
  boldText: {
    fontWeight: 'bold',
    color: THEME.text,
  }
});
