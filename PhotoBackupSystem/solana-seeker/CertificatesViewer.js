/**
 * CertificatesViewer.js
 * 
 * Modal viewer for NFT Certificates of Authenticity (Limited Edition).
 * Certificates persist via SecureStore across app restarts/updates.
 * Supports viewing, sharing, and deleting certificates.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Share,
  ActivityIndicator,
  Platform,
  ScrollView,
  BackHandler,
  StatusBar,
  Dimensions,
  AppState,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import NFTOperations from './nftOperations';
import * as WalletAdapter from './WalletAdapter';
import { t, getCurrentLanguage } from './i18n';
import * as Application from 'expo-application';

const COLORS = {
  background: '#030308',
  surface: '#0A0A14',
  card: '#12121E',
  border: 'rgba(167,139,250,0.12)',
  text: '#EEEEF6',
  textSecondary: '#7676A0',
  primary: '#6C5CE7',
  accent: '#F5C842',
  error: '#FF4466',
};

const PAGE_SIZE = 10;
const CERT_PASSIVE_REFRESH_MS = 300000;
const SCREEN_HEIGHT = Dimensions.get('window').height;
const SCREEN_HEIGHT_FULL = Dimensions.get('screen').height;
const ANDROID_NAV_BAR_HEIGHT = Platform.OS === 'android' ? Math.max(48, SCREEN_HEIGHT_FULL - SCREEN_HEIGHT) : 0;

const CERTIFICATE_PROVENANCE_LABELS = {
  en: { transferProvenance: 'Transfer Provenance', transferredFrom: 'From', transferredAt: 'Transferred', currentOwner: 'Current Owner' },
  'en-GB': { transferProvenance: 'Transfer Provenance', transferredFrom: 'From', transferredAt: 'Transferred', currentOwner: 'Current Owner' },
  ar: { transferProvenance: 'سجل النقل', transferredFrom: 'من', transferredAt: 'تم النقل', currentOwner: 'المالك الحالي' },
  bg: { transferProvenance: 'История на прехвърлянето', transferredFrom: 'От', transferredAt: 'Прехвърлено', currentOwner: 'Текущ собственик' },
  cs: { transferProvenance: 'Historie převodu', transferredFrom: 'Od', transferredAt: 'Převedeno', currentOwner: 'Současný vlastník' },
  da: { transferProvenance: 'Overførselshistorik', transferredFrom: 'Fra', transferredAt: 'Overført', currentOwner: 'Nuværende ejer' },
  de: { transferProvenance: 'Übertragungsverlauf', transferredFrom: 'Von', transferredAt: 'Übertragen', currentOwner: 'Aktueller Eigentümer' },
  el: { transferProvenance: 'Ιστορικό μεταφοράς', transferredFrom: 'Από', transferredAt: 'Μεταφέρθηκε', currentOwner: 'Τρέχων κάτοχος' },
  es: { transferProvenance: 'Historial de transferencia', transferredFrom: 'De', transferredAt: 'Transferido', currentOwner: 'Propietario actual' },
  et: { transferProvenance: 'Ülekande ajalugu', transferredFrom: 'Kellelt', transferredAt: 'Üle kantud', currentOwner: 'Praegune omanik' },
  fi: { transferProvenance: 'Siirtohistoria', transferredFrom: 'Lähettäjä', transferredAt: 'Siirretty', currentOwner: 'Nykyinen omistaja' },
  fr: { transferProvenance: 'Historique du transfert', transferredFrom: 'De', transferredAt: 'Transféré', currentOwner: 'Propriétaire actuel' },
  hi: { transferProvenance: 'हस्तांतरण इतिहास', transferredFrom: 'से', transferredAt: 'स्थानांतरित', currentOwner: 'वर्तमान स्वामी' },
  hr: { transferProvenance: 'Povijest prijenosa', transferredFrom: 'Od', transferredAt: 'Preneseno', currentOwner: 'Trenutni vlasnik' },
  hu: { transferProvenance: 'Átadási előzmények', transferredFrom: 'Feladó', transferredAt: 'Átadva', currentOwner: 'Jelenlegi tulajdonos' },
  id: { transferProvenance: 'Riwayat transfer', transferredFrom: 'Dari', transferredAt: 'Ditransfer', currentOwner: 'Pemilik saat ini' },
  it: { transferProvenance: 'Cronologia del trasferimento', transferredFrom: 'Da', transferredAt: 'Trasferito', currentOwner: 'Proprietario attuale' },
  ja: { transferProvenance: '譲渡履歴', transferredFrom: '譲渡元', transferredAt: '譲渡日', currentOwner: '現在の所有者' },
  ko: { transferProvenance: '이전 이력', transferredFrom: '이전 전 소유자', transferredAt: '이전일', currentOwner: '현재 소유자' },
  lt: { transferProvenance: 'Perdavimo istorija', transferredFrom: 'Nuo', transferredAt: 'Perduota', currentOwner: 'Dabartinis savininkas' },
  lv: { transferProvenance: 'Pārsūtīšanas vēsture', transferredFrom: 'No', transferredAt: 'Pārsūtīts', currentOwner: 'Pašreizējais īpašnieks' },
  nl: { transferProvenance: 'Overdrachtsgeschiedenis', transferredFrom: 'Van', transferredAt: 'Overgedragen', currentOwner: 'Huidige eigenaar' },
  no: { transferProvenance: 'Overføringshistorikk', transferredFrom: 'Fra', transferredAt: 'Overført', currentOwner: 'Nåværende eier' },
  pl: { transferProvenance: 'Historia transferu', transferredFrom: 'Od', transferredAt: 'Przeniesiono', currentOwner: 'Obecny właściciel' },
  pt: { transferProvenance: 'Histórico de transferência', transferredFrom: 'De', transferredAt: 'Transferido', currentOwner: 'Proprietário atual' },
  'pt-BR': { transferProvenance: 'Histórico de transferência', transferredFrom: 'De', transferredAt: 'Transferido', currentOwner: 'Proprietário atual' },
  ro: { transferProvenance: 'Istoric transfer', transferredFrom: 'De la', transferredAt: 'Transferat', currentOwner: 'Proprietar actual' },
  ru: { transferProvenance: 'История передачи', transferredFrom: 'От', transferredAt: 'Передано', currentOwner: 'Текущий владелец' },
  sv: { transferProvenance: 'Överföringshistorik', transferredFrom: 'Från', transferredAt: 'Överfört', currentOwner: 'Nuvarande ägare' },
  tr: { transferProvenance: 'Transfer geçmişi', transferredFrom: 'Kimden', transferredAt: 'Transfer edildi', currentOwner: 'Mevcut sahip' },
  uk: { transferProvenance: 'Історія передачі', transferredFrom: 'Від', transferredAt: 'Передано', currentOwner: 'Поточний власник' },
  zh: { transferProvenance: '转移记录', transferredFrom: '来自', transferredAt: '转移时间', currentOwner: '当前所有者' },
};

const certificateLabel = (key, fallback) => {
  const translationKey = `certificates.${key}`;
  const translated = t(translationKey);
  if (translated && translated !== translationKey) return translated;
  const locale = getCurrentLanguage();
  const labels = CERTIFICATE_PROVENANCE_LABELS[locale] || CERTIFICATE_PROVENANCE_LABELS[locale?.split?.('-')?.[0]] || CERTIFICATE_PROVENANCE_LABELS.en;
  return labels?.[key] || fallback;
};

const SLIM_CERT_FIELDS = [
  'id', 'name', 'createdAt', 'issuedAt', 'mintAddress', 'txSignature',
  'certificationMode', 'edition', 'encrypted', 'watermarked', 'hasRfc3161',
  'hasC2pa', 'contentHash', 'exifRawHash', 'exifHash', 'exifBindingHash',
  'cameraHash', 'license', 'storageType', 'metadataUrl', 'ownerAddress',
  'creatorWallet', 'description', 'mintedAt', 'imageUrl', 'transferredFrom', 'transferredAt',
];
const slimCertificateForState = (cert) => {
  const slim = {};
  for (const field of SLIM_CERT_FIELDS) {
    if (cert?.[field] !== undefined) slim[field] = cert[field];
  }
  return slim;
};
const slimCertificateListForState = (certs) => Array.isArray(certs) ? certs.map(slimCertificateForState) : [];

const CertificatesViewer = ({ visible, onClose, serverUrl, getAuthHeaders, onShowNFT, pendingSelectMint, onPendingSelectConsumed, onCertificateCountChange }) => {
  const insets = useSafeAreaInsets();
  const bottomInset = Platform.OS === 'android' ? (insets.bottom || ANDROID_NAV_BAR_HEIGHT) : insets.bottom;
  const headerTopInset = Platform.OS === 'ios' ? insets.top + 12 : 16;
  const [certificates, setCertificates] = useState([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedCert, setSelectedCert] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingHeavyFields, setLoadingHeavyFields] = useState(false);
  const [darkAlert, setDarkAlert] = useState(null);

  const showDarkAlert = (title, message, buttons = [{ text: t('common.ok'), onPress: () => setDarkAlert(null) }]) => {
    setDarkAlert({ title, message, buttons });
  };

  const openCertificateDetail = useCallback(async (cert) => {
    setSelectedCert(cert);
    try {
      const full = await NFTOperations.getCertificateFullData(cert.id, cert);
      if (full) {
        setSelectedCert(prev => prev?.id === cert.id ? { ...cert, ...full } : prev);
      }
    } catch (_) {}
  }, []);

  const _loadingCertIdRef = React.useRef(null);

  // Auto-load heavy fields from disk when certificate is selected (fast, no network)
  useEffect(() => {
    if (!selectedCert || !selectedCert.id) return;
    if (_loadingCertIdRef.current === selectedCert.id) return;
    if (selectedCert.rfc3161Token) { setLoadingHeavyFields(false); return; }
    _loadingCertIdRef.current = selectedCert.id;
    const certId = selectedCert.id;
    setLoadingHeavyFields(true);

    (async () => {
      try {
        const diskData = await NFTOperations.getCertificateFullData(certId, selectedCert);
        if (diskData?.rfc3161Token || diskData?.c2paManifest) {
          setSelectedCert(prev => prev?.id === certId ? ({
            ...prev,
            rfc3161Token: diskData.rfc3161Token || prev.rfc3161Token,
            c2paManifest: diskData.c2paManifest || prev.c2paManifest,
          }) : prev);
        }
        // If not on disk, user can press "Load Full Token" button to fetch from IPFS
      } catch (e) {
        console.warn('[Certs] Disk heavy field load failed:', e?.message);
      } finally {
        setLoadingHeavyFields(false);
      }
    })();
  }, [selectedCert?.id]);

  // Reset loading ref when cert is deselected
  useEffect(() => {
    if (!selectedCert) _loadingCertIdRef.current = null;
  }, [selectedCert]);

  const resolveMatchingStoredNFT = async (cert) => {
    if (!cert) return null;
    try {
      const normMint = (m) => m ? String(m).replace(/^cnft_/, '') : '';
      const certMint = normMint(cert.mintAddress);
      const nfts = await NFTOperations.getStoredNFTs();
      return nfts.find(n => {
        const nftMint = normMint(n?.mintAddress || n?.assetId || '');
        if (certMint && nftMint && nftMint === certMint) return true;
        if (cert.txSignature && n?.txSignature && n.txSignature === cert.txSignature) return true;
        return false;
      }) || null;
    } catch (_) {
      return null;
    }
  };

  const resolveCertMetadataUrl = async (cert) => {
    if (!cert) return null;
    if (cert.metadataUrl) return cert.metadataUrl;
    try {
      const match = await resolveMatchingStoredNFT(cert);
      return match?.metadataUrl || null;
    } catch (_) {
      return null;
    }
  };

  const fetchFullCertificateFromServer = async (cert) => {
    if (!serverUrl || !getAuthHeaders || !cert?.id) return null;
    try {
      const authConfig = await getAuthHeaders();
      const headers = authConfig?.headers || authConfig;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const status = WalletAdapter.getConnectionStatus ? WalletAdapter.getConnectionStatus() : null;
      const walletQuery = status?.address ? `&walletAddress=${encodeURIComponent(status.address)}` : '';
      const url = `${serverUrl}/api/nft/certificates?full=true&id=${encodeURIComponent(cert.id)}${walletQuery}`;
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) return null;
      const data = await res.json();
      const fullCert = data?.certificate || null;
      if (!fullCert) return null;
      if (fullCert.rfc3161Token || fullCert.c2paManifest) {
        try { await NFTOperations.saveCertificate({ ...cert, ...fullCert }); } catch (_) {}
      }
      return fullCert;
    } catch (_) {
      return null;
    }
  };

  // On-demand IPFS recovery for a single cert's heavy fields
  const loadTokenFromIPFS = async (cert) => {
    if (!cert?.id) return null;
    const matchingNFT = await resolveMatchingStoredNFT(cert);
    const nftMetaCert = matchingNFT?.metadata?.properties?.certificate;
    const nftUpdates = {};
    if (matchingNFT?.metadataUrl) nftUpdates.metadataUrl = matchingNFT.metadataUrl;
    if (nftMetaCert?.rfc3161?.tsaTokenBase64) nftUpdates.rfc3161Token = nftMetaCert.rfc3161.tsaTokenBase64;
    if (matchingNFT?.metadata?.properties?.c2pa) nftUpdates.c2paManifest = matchingNFT.metadata.properties.c2pa;
    if (Object.keys(nftUpdates).length > 0) {
      try { await NFTOperations.saveCertificate({ ...cert, ...nftUpdates }); } catch (_) {}
      if (nftUpdates.rfc3161Token) {
        return nftUpdates;
      }
    }
    const resolvedMetadataUrl = await resolveCertMetadataUrl(cert);
    if (!resolvedMetadataUrl) return null;
    const extractCid = (url) => { const m = (url || '').match(/(?:ipfs\/|ipfs:\/\/)([a-zA-Z0-9]+)/); return m ? m[1] : null; };
    const IPFS_GWS = ['https://gateway.pinata.cloud/ipfs/', 'https://dweb.link/ipfs/', 'https://w3s.link/ipfs/'];
    const cid = extractCid(resolvedMetadataUrl);
    const urls = cid ? IPFS_GWS.map(g => g + cid) : [resolvedMetadataUrl];
    let metaJson = null;
    for (const u of urls) {
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 8000);
        const resp = await fetch(u, { signal: ctrl.signal });
        clearTimeout(tid);
        if (!resp.ok) continue;
        const text = await resp.text();
        try { metaJson = JSON.parse(text); break; } catch (_) {}
      } catch (_) {}
    }
    if (metaJson?.properties?.certificate) {
      const mc = metaJson.properties.certificate;
      const updates = { metadataUrl: resolvedMetadataUrl };
      if (mc.rfc3161?.tsaTokenBase64) updates.rfc3161Token = mc.rfc3161.tsaTokenBase64;
      if (metaJson.properties.c2pa) updates.c2paManifest = metaJson.properties.c2pa;
      if (Object.keys(updates).length > 0) {
        try { await NFTOperations.saveCertificate({ ...cert, ...updates }); } catch (_) {}
        if (updates.rfc3161Token) {
          return updates;
        }
      }
    }
    return null;
  };

  const _certLoadingRef = React.useRef(false);
  const prepareVisibleCertificates = useCallback(async (sourceCerts, { prune = false } = {}) => {
    const certs = Array.isArray(sourceCerts) ? sourceCerts.map(c => ({ ...c })) : [];
    for (const c of certs) {
      if (c.rfc3161Token) { c.hasRfc3161 = true; delete c.rfc3161Token; }
      if (c.c2paManifest) { c.hasC2pa = true; delete c.c2paManifest; }
    }
    console.log('[Certs] Loaded', certs.length, 'certificates from storage');

    const allNFTs = await NFTOperations.getStoredNFTs();
    console.log('[Certs] Loaded', allNFTs.length, 'NFTs from storage');
    const normMint = (m) => m ? String(m).replace(/^cnft_/, '') : '';
    const nftMap = {};
    for (const n of allNFTs) {
      const key = normMint(n.mintAddress);
      if (key) nftMap[key] = n;
    }

    let enriched = 0;
    try {
      for (const c of certs) {
        const nft = nftMap[normMint(c.mintAddress)];
        if (!nft) continue;
        const attrs = nft.metadata?.attributes || nft.attributes || [];
        if (!c.contentHash) { const a = attrs.find(x => x.trait_type === 'Content Hash'); if (a) { c.contentHash = a.value; enriched++; } }
        if (!c.exifRawHash) { const a = attrs.find(x => x.trait_type === 'EXIF Raw Hash'); if (a) { c.exifRawHash = a.value; enriched++; } }
        if (!c.exifHash) { const a = attrs.find(x => x.trait_type === 'EXIF Hash'); if (a) { c.exifHash = a.value; enriched++; } }
        if (!c.exifBindingHash) { const a = attrs.find(x => x.trait_type === 'EXIF Binding Hash'); if (a) { c.exifBindingHash = a.value; enriched++; } }
        if (!c.cameraHash) { const a = attrs.find(x => x.trait_type === 'Camera Hash'); if (a) { c.cameraHash = a.value; enriched++; } }
        if (!c.license || c.license === 'arr') { const a = attrs.find(x => x.trait_type === 'License'); if (a) { c.license = a.value; enriched++; } }
        if (!c.storageType && nft.storageType) { c.storageType = nft.storageType; enriched++; }
        if (!c.encrypted && nft.encrypted) { c.encrypted = nft.encrypted; enriched++; }
        if (!c.watermarked && nft.watermarked) { c.watermarked = nft.watermarked; enriched++; }
        if (!c.metadataUrl && nft.metadataUrl) { c.metadataUrl = nft.metadataUrl; enriched++; }
        const metaCert = nft.metadata?.properties?.certificate;
        if (metaCert?.rfc3161?.tsaTokenBase64) {
          if (!c.hasRfc3161) { c.hasRfc3161 = true; enriched++; }
        }
        if (nft.metadata?.properties?.c2pa) {
          if (!c.hasC2pa) { c.hasC2pa = true; enriched++; }
        }
        if (!c.hasRfc3161) { const a = attrs.find(x => x.trait_type === 'RFC 3161 Timestamp'); if (a) { c.hasRfc3161 = true; enriched++; } }
        if (!c.hasC2pa) { const a = attrs.find(x => x.trait_type === 'C2PA Provenance'); if (a) { c.hasC2pa = true; enriched++; } }
        if (!c.hasRfc3161 && nft.hasRfc3161) { c.hasRfc3161 = true; enriched++; }
        if (!c.hasC2pa && nft.hasC2pa) { c.hasC2pa = true; enriched++; }
        if (c.edition === 'limited' && !c.hasRfc3161) { c.hasRfc3161 = true; enriched++; }
        if (c.edition === 'limited' && !c.hasC2pa) { c.hasC2pa = true; enriched++; }
      }
    } catch (_) {}

    let filtered = certs;
    try {
      const status = WalletAdapter.getConnectionStatus ? WalletAdapter.getConnectionStatus() : null;
      const addr = status?.address || null;
      console.log('[Certs] Wallet addr:', addr, 'allNFTs.length:', allNFTs.length);
      if (addr && allNFTs.length > 0) {
        const ownedSet = new Set(
          allNFTs
            .filter(n => (n?.ownerAddress || '') === addr)
            .map(n => normMint(n?.mintAddress || n?.assetId || ''))
            .filter(Boolean)
        );
        if (ownedSet.size > 0) {
          const orphans = [];
          filtered = certs.filter(c => {
            const id = normMint(c?.mintAddress || '');
            if (id && id.startsWith('tx_')) return true;
            const owned = id && ownedSet.has(id);
            if (!owned && id) orphans.push(c);
            return owned;
          });
          console.log('[Certs] Ownership filter: ownedSet size=', ownedSet.size, 'filtered=', filtered.length, '/', certs.length);

          // Prune orphan certs (NFT was burned or transferred away) from local storage so they
          // stop loading on subsequent refreshes. Only run after a fresh server sync to avoid
          // accidentally deleting real certs while the NFT cache is still warming up.
          if (prune && orphans.length > 0) {
            console.log('[Certs] Pruning', orphans.length, 'orphaned cert(s) (NFT no longer owned)');
            for (const orphan of orphans) {
              try { await NFTOperations.removeCertificateByMint(orphan.mintAddress); } catch (_) { }
            }
          }
        } else {
          console.log('[Certs] Ownership filter skipped — no NFTs have ownerAddress for', addr);
        }
      }
    } catch (filterErr) { console.warn('[Certs] Ownership filter error:', filterErr?.message); }

    const seen = new Set();
    const unique = filtered
      .filter(c => {
        if (!c.id || seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      })
      .sort((a, b) => new Date(b.createdAt || b.issuedAt) - new Date(a.createdAt || a.issuedAt));
    console.log('[Certs] After dedup:', unique.length, 'certificates to display');
    return { certs, unique, enriched };
  }, []);
  const loadCertificates = useCallback(async (isBackground = false) => {
    // Prevent concurrent calls — previous cycle may still be running (IPFS fetches can take 30s+)
    if (_certLoadingRef.current) return;
    _certLoadingRef.current = true;
    if (!isBackground) setLoading(true);
    try {
      if (!isBackground) {
        const cachedCerts = await NFTOperations.getStoredCertificates();
        const { unique: cachedUnique } = await prepareVisibleCertificates(cachedCerts);
        setCertificates(slimCertificateListForState(cachedUnique));
        if (onCertificateCountChange) onCertificateCountChange(cachedUnique.length);
        setCurrentPage(0);
        setLoading(false);
      }
      // Sync: pull remote certs (backup is handled by App.js every 5min — skip here entirely)
      if (serverUrl && getAuthHeaders) {
        try {
          const authConfig = await getAuthHeaders();
          const headers = authConfig?.headers || authConfig;
          const walletStatus = WalletAdapter.getConnectionStatus ? WalletAdapter.getConnectionStatus() : null;
          await NFTOperations.syncCertificatesFromServer('https://stealthlynk.io', headers, walletStatus?.address || '');
        } catch (_) {}
      }
      const freshCerts = await NFTOperations.getStoredCertificates();
      const { certs, unique, enriched } = await prepareVisibleCertificates(freshCerts, { prune: true });
      setCertificates(slimCertificateListForState(unique));
      if (onCertificateCountChange) onCertificateCountChange(unique.length);
      setCurrentPage(0);
      if (!isBackground) setLoading(false);
      
      // Save after enrichment (lightweight — no heavy fields in memory, recovery is on-demand per cert)
      if (enriched > 0) {
        console.log(`[Certs] Enriched ${enriched} fields total`);
        try { await NFTOperations.saveAllCertificates(certs); } catch (_) {}
      }
    } catch (e) {
      console.warn('[Certs] Failed to load:', e?.message);
    } finally {
      _certLoadingRef.current = false;
      if (!isBackground) setLoading(false);
    }
  }, [serverUrl, getAuthHeaders, prepareVisibleCertificates, onCertificateCountChange]);

  useEffect(() => {
    if (visible) { setCurrentPage(0); loadCertificates(false); }
    else {
      setCertificates([]);
      setSelectedCert(null);
      setCurrentPage(0);
      setLoading(true);
    }
    if (!visible) return;
    const interval = setInterval(() => loadCertificates(true), CERT_PASSIVE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [visible, loadCertificates]);

  useEffect(() => {
    if (!visible) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void loadCertificates(true);
      }
    });
    return () => sub.remove();
  }, [visible, loadCertificates]);

  // Auto-select certificate when navigating from NFTGallery
  useEffect(() => {
    if (!visible || !pendingSelectMint || certificates.length === 0) return;
    const normMint = (m) => m ? String(m).replace(/^cnft_/, '') : '';
    const target = normMint(pendingSelectMint);
    const matchIdx = certificates.findIndex(c => normMint(c.mintAddress) === target);
    if (matchIdx >= 0) {
      const match = certificates[matchIdx];
      // Navigate to the correct page
      setCurrentPage(Math.floor(matchIdx / PAGE_SIZE));
      // Lazy-load heavy fields for detail view (pass in-memory cert to skip index re-read)
      setLoadingDetail(true);
      NFTOperations.getCertificateFullData(match.id, match).then(full => { setSelectedCert(full || match); setLoadingDetail(false); }).catch(() => { setSelectedCert(match); setLoadingDetail(false); });
    }
    onPendingSelectConsumed?.();
  }, [visible, pendingSelectMint, certificates]);

  const handleShare = async (cert) => {
    try {
      // Lazy-load heavy fields for export (rfc3161Token needed for verify commands)
      const full = await NFTOperations.getCertificateFullData(cert.id, cert) || cert;
      const text = NFTOperations.formatCertificateForExport(full);
      await Share.share({ message: text, title: `${t('certificates.certificateOfAuth')} — ${cert.name}` });
    } catch (e) {
      if (e.message !== 'User did not share') {
        showDarkAlert(t('common.error'), e.message);
      }
    }
  };

  const handleDelete = (cert) => {
    showDarkAlert(
      t('certificates.archiveRecord') || 'Archive Proof Record',
      t('certificates.archiveConfirm', { name: cert.name }) || `Archive proof record for "${cert.name}"?\nThis removes it from your local view only. The on-chain record remains permanent and will sync back on next refresh.`,
      [
        { text: t('common.cancel'), onPress: () => setDarkAlert(null) },
        {
          text: t('certificates.archive') || 'Archive',
          onPress: async () => {
            setDarkAlert(null);
            await NFTOperations.removeCertificate(cert.id);
            if (selectedCert?.id === cert.id) setSelectedCert(null);
            loadCertificates();
          },
        },
      ]
    );
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return 'N/A';
    try {
      const d = new Date(dateStr);
      const lang = getCurrentLanguage() || 'en';
      return d.toLocaleString(lang, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return dateStr; }
  };

  const renderCertCard = ({ item }) => {
    return (
    <TouchableOpacity
      style={[styles.certCard, selectedCert?.id === item.id && styles.certCardSelected]}
      onPress={() => { void openCertificateDetail(item); }}
      activeOpacity={0.7}
    >
      <View style={styles.certCardHeader}>
        <View style={styles.certBadge}>
          <Feather name="award" size={16} color="#f59e0b" />
        </View>
        <View style={styles.certCardInfo}>
          <Text style={styles.certCardName} numberOfLines={1}>{item.name || t('certificates.untitled')}</Text>
          <Text style={styles.certCardDate}>{formatDate(item.createdAt || item.issuedAt)}</Text>
        </View>
        {/* Share hidden for now — kept for future development */}
        {false && (
        <TouchableOpacity onPress={() => handleShare(item)} style={styles.certIconBtn}>
          <Feather name="share-2" size={16} color={COLORS.textSecondary} />
        </TouchableOpacity>
        )}
      </View>
      {/* Microcopy — trust reinforcement */}
      <Text style={{ fontSize: 9, color: '#6b7280', marginTop: 4, marginBottom: 6 }}>{t('certificates.sha256Microcopy')}</Text>
      {/* Standards as pillars — full descriptive labels */}
      <View style={styles.certCardMeta}>
        {/* Private/Public badge — matches album colors */}
        <View style={[styles.certTag, { borderColor: (item.certificationMode === 'public' || (!item.certificationMode && item.edition === 'open')) ? 'rgba(34,197,94,0.3)' : 'rgba(245,158,11,0.3)', backgroundColor: (item.certificationMode === 'public' || (!item.certificationMode && item.edition === 'open')) ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.08)' }]}>
          <Text style={[styles.certTagText, { color: (item.certificationMode === 'public' || (!item.certificationMode && item.edition === 'open')) ? '#22c55e' : '#f59e0b' }]}>{(item.certificationMode === 'public' || (!item.certificationMode && item.edition === 'open')) ? '🌍 ' + (t('certificates.publicCertification') || 'Public Certified') : '🔐 ' + (t('certificates.privateCertification') || 'Private Certified')}</Text>
        </View>
        {/* Encrypted badge — matches album amber color */}
        {item.encrypted && (
          <View style={[styles.certTag, { borderColor: 'rgba(245,158,11,0.3)', backgroundColor: 'rgba(245,158,11,0.08)' }]}>
            <Feather name="lock" size={10} color="#f59e0b" />
            <Text style={[styles.certTagText, { color: '#f59e0b' }]}>{t('certificates.encrypted')}</Text>
          </View>
        )}
        {/* Watermarked badge — matches album green color */}
        {item.watermarked && (
          <View style={[styles.certTag, { borderColor: 'rgba(34,197,94,0.3)', backgroundColor: 'rgba(34,197,94,0.08)' }]}>
            <Feather name="check-circle" size={10} color="#22c55e" />
            <Text style={[styles.certTagText, { color: '#22c55e' }]}>{t('certificates.watermarked')}</Text>
          </View>
        )}
        {item.hasRfc3161 && (
          <View style={[styles.certTag, { borderColor: 'rgba(16,185,129,0.4)', backgroundColor: 'rgba(16,185,129,0.08)' }]}>
            <Feather name="check-circle" size={10} color="#10b981" />
            <Text style={[styles.certTagText, { color: '#10b981' }]}>{t('certificates.rfc3161Pillar') || '✔ Timestamp (RFC 3161)'}</Text>
          </View>
        )}
        {/* C2PA badge — matches album white/neutral color */}
        {item.hasC2pa && (
          <View style={[styles.certTag, { borderColor: 'rgba(255,255,255,0.3)', backgroundColor: 'rgba(255,255,255,0.1)' }]}>
            <Feather name="check-circle" size={10} color="#fff" />
            <Text style={[styles.certTagText, { color: '#fff' }]}>{t('certificates.c2paPillar') || '✔ Authenticity (C2PA)'}</Text>
          </View>
        )}
        {/* Hash badge — emerald (consistent with RFC 3161) */}
        {item.contentHash && (
          <View style={[styles.certTag, { borderColor: 'rgba(16,185,129,0.3)', backgroundColor: 'rgba(16,185,129,0.06)' }]}>
            <Feather name="hash" size={10} color="#10b981" />
            <Text style={[styles.certTagText, { color: '#10b981' }]}>{t('certificates.hashPillar') || '✔ Cryptographic Hash'}</Text>
          </View>
        )}
        {/* Immutable Anchor badge — neutral blue-gray */}
        <View style={[styles.certTag, { borderColor: 'rgba(59,130,246,0.3)', backgroundColor: 'rgba(59,130,246,0.06)' }]}>
          <Feather name="anchor" size={10} color="#3b82f6" />
          <Text style={[styles.certTagText, { color: '#3b82f6' }]}>{t('certificates.anchorPillar') || '✔ Immutable Anchor'}</Text>
        </View>
        {/* License badge — matches album amber color */}
        {item.license && (
          <View style={[styles.certTag, { borderColor: 'rgba(245,158,11,0.3)', backgroundColor: 'rgba(245,158,11,0.08)' }]}>
            <Feather name="file-text" size={10} color="#f59e0b" />
            <Text style={[styles.certTagText, { color: '#f59e0b' }]}>{item.license === 'arr' ? t('certificates.allRightsReserved') : item.license}</Text>
          </View>
        )}
        {/* On-chain badge — matches album amber color */}
        {item.storageType === 'onchain' && (
          <View style={[styles.certTag, { borderColor: 'rgba(245,158,11,0.3)', backgroundColor: 'rgba(245,158,11,0.08)' }]}>
            <Feather name="code" size={10} color="#f59e0b" />
            <Text style={[styles.certTagText, { color: '#f59e0b' }]}>{t('certificates.embeddedSvg')}</Text>
          </View>
        )}
        {/* Arweave badge — matches album purple color */}
        {item.storageType === 'arweave' && (
          <View style={[styles.certTag, { borderColor: 'rgba(153,69,255,0.3)', backgroundColor: 'rgba(153,69,255,0.08)' }]}>
            <Feather name="globe" size={10} color="#9945FF" />
            <Text style={[styles.certTagText, { color: '#9945FF' }]}>Arweave</Text>
          </View>
        )}
        {/* IPFS badge — matches album purple color */}
        {(!item.storageType || item.storageType === 'ipfs') && (
          <View style={[styles.certTag, { borderColor: 'rgba(153,69,255,0.3)', backgroundColor: 'rgba(153,69,255,0.08)' }]}>
            <Feather name="globe" size={10} color="#9945FF" />
            <Text style={[styles.certTagText, { color: '#9945FF' }]}>IPFS</Text>
          </View>
        )}
      </View>
      {item.mintAddress && (
        <Text style={styles.certMintAddr} numberOfLines={1}>
          {item.mintAddress.slice(0, 20)}...{item.mintAddress.slice(-8)}
        </Text>
      )}
    </TouchableOpacity>
  );
  };

  const renderDetail = () => {
    if (!selectedCert) return null;
    const c = selectedCert;
    return (
      <View style={[styles.detailContainer, { paddingBottom: bottomInset }]}>
        <View style={styles.detailHeader}>
          <TouchableOpacity onPress={() => setSelectedCert(null)} style={styles.detailBack}>
            <Feather name="arrow-left" size={20} color={COLORS.text} />
          </TouchableOpacity>
          <Text style={styles.detailTitle} numberOfLines={1}>{c.name || t('certificates.title')}</Text>
          {/* Share hidden for now — kept for future development */}
          {false && (
          <TouchableOpacity onPress={() => handleShare(c)} style={styles.detailShareBtn}>
            <Feather name="share-2" size={18} color="#f59e0b" />
          </TouchableOpacity>
          )}
        </View>

        <ScrollView contentContainerStyle={[styles.detailScrollContent, { paddingBottom: 16 + bottomInset }]} showsVerticalScrollIndicator={false} bounces={false}>
        <View style={styles.detailCard}>
          <View style={styles.detailBadgeRow}>
            <Feather name="award" size={32} color="#f59e0b" />
            <Text style={styles.detailBadgeText}>{t('certificates.certificateOfAuth')}</Text>
          </View>

          <View style={styles.detailDivider} />

          <DetailRow label={t('certificates.certification') || 'Certification'} value={(c.certificationMode === 'public' || (!c.certificationMode && c.edition === 'open')) ? (t('certificates.publicCertification') || 'Public Certified') : (t('certificates.privateCertification') || 'Private Certified')} />
          <DetailRow label={t('certificates.license')} value={({'arr':t('certificates.allRightsReserved'),'cc-by':'CC BY 4.0','cc-by-sa':'CC BY-SA 4.0','cc-by-nc':'CC BY-NC 4.0','cc-by-nc-sa':'CC BY-NC-SA 4.0','cc-by-nd':'CC BY-ND 4.0','cc-by-nc-nd':'CC BY-NC-ND 4.0','cc0':'CC0 1.0 (Public Domain)','commercial':t('nftMint.licenseCommercial')})[c.license] || c.license || t('certificates.allRightsReserved')} />
          <DetailRow label={t('certificates.issued')} value={formatDate(c.issuedAt)} />

          <View style={styles.detailDivider} />
          <Text style={styles.detailSectionTitle}>{t('certificates.blockchainProof')}</Text>
          <DetailRow label={t('certificates.mintAddress')} value={c.mintAddress || 'N/A'} mono />
          <DetailRow label={t('certificates.transaction')} value={c.txSignature || 'N/A'} mono />
          <DetailRow label={t('certificates.creatorWallet')} value={c.creatorWallet || 'N/A'} mono />

          <View style={styles.detailDivider} />
          <Text style={styles.detailSectionTitle}>{t('certificates.integrityProof')}</Text>
          <DetailRow label={t('certificates.contentHash')} value={c.contentHash || 'N/A'} mono />
          <DetailRow label={t('certificates.exifRawHash') || 'Raw EXIF Hash'} value={c.exifRawHash || 'N/A'} mono />
          <DetailRow label={t('certificates.exifHash')} value={c.exifHash || 'N/A'} mono />
          <DetailRow label={t('certificates.exifBindingHash') || 'EXIF Binding Hash'} value={c.exifBindingHash || 'N/A'} mono />

          <View style={styles.verifyBox}>
            <Text style={styles.verifyTitle}>{t('certificates.howToVerify')}</Text>
            <Text style={styles.verifyText}>
              <Text style={styles.verifyBold}>{t('certificates.contentHashVerify')}</Text>{' '}
              <Text style={styles.verifyCode}>sha256sum {'<file>'}</Text>
            </Text>
            <TouchableOpacity
              activeOpacity={0.6}
              onPress={() => {
                Clipboard.setStringAsync('sha256sum <file>');
                showDarkAlert(t('alerts.copied') || 'Copied', t('alerts.commandCopied') || 'Command copied to clipboard');
              }}
              style={styles.verifyCodeCopyable}
            >
              <Text style={styles.verifyCodeBlock} selectable>sha256sum {'<file>'}</Text>
              <Feather name="copy" size={12} color="#f59e0b" />
            </TouchableOpacity>
            <Text style={styles.verifyText}>
              <Text style={styles.verifyBold}>{t('certificates.exifHashVerify')}</Text>
            </Text>
            <TouchableOpacity
              activeOpacity={0.6}
              onPress={() => {
                const cmd = 'npm install exifreader && node verify-exif-hash.js <file>';
                Clipboard.setStringAsync(cmd);
                showDarkAlert(t('alerts.copied') || 'Copied', t('alerts.commandCopied') || 'Command copied to clipboard');
              }}
              style={styles.verifyCodeCopyable}
            >
              <Text style={styles.verifyCodeBlock} selectable>
                {'npm install exifreader && node verify-exif-hash.js <file>'}
              </Text>
              <Feather name="copy" size={12} color="#f59e0b" />
            </TouchableOpacity>
            <Text style={styles.verifyNote}>
              {t('certificates.verifyNote')}
            </Text>
          </View>

          <View style={styles.detailDivider} />
          <Text style={styles.detailSectionTitle}>{t('certificates.details')}</Text>
          <DetailRow label={t('certificates.watermarked')} value={c.watermarked ? t('common.yes') : t('common.no')} />
          <DetailRow label={t('certificates.encrypted')} value={c.encrypted ? t('common.yes') : t('common.no')} />
          <DetailRow label={t('certificates.storage')} value={c.storageType === 'cloud' ? 'StealthCloud' : c.storageType === 'arweave' ? 'Arweave (Permanent)' : c.storageType === 'onchain' ? 'Embedded (On-Chain)' : 'IPFS'} />
          {c.transferredFrom && (
            <>
              <View style={styles.detailDivider} />
              <Text style={styles.detailSectionTitle}>{certificateLabel('transferProvenance', 'Transfer Provenance')}</Text>
              <DetailRow label={certificateLabel('transferredFrom', 'From')} value={`${c.transferredFrom.slice(0, 6)}...${c.transferredFrom.slice(-4)}`} />
              {c.transferredAt && <DetailRow label={certificateLabel('transferredAt', 'Transferred')} value={new Date(c.transferredAt).toLocaleDateString()} />}
              <DetailRow label={certificateLabel('currentOwner', 'Current Owner')} value={c.ownerAddress ? `${c.ownerAddress.slice(0, 6)}...${c.ownerAddress.slice(-4)}` : 'N/A'} />
            </>
          )}
          {(c.hasRfc3161 || c.rfc3161Token) && (
            <>
              <View style={styles.detailDivider} />
              <Text style={styles.detailSectionTitle}>{t('certificates.rfc3161Title')}</Text>
              <DetailRow label={t('certificates.rfc3161Authority')} value={c.rfc3161Tsa ? (c.rfc3161Tsa.includes('digicert') ? 'DigiCert' : c.rfc3161Tsa.includes('sectigo') ? 'Sectigo' : c.rfc3161Tsa.includes('freetsa') ? 'FreeTSA.org' : c.rfc3161Tsa) : t('certificates.rfc3161AuthorityValue')} />
              <DetailRow label={t('certificates.rfc3161Standard')} value={t('certificates.rfc3161StandardValue')} />
              <DetailRow label={t('certificates.rfc3161HashAlgo')} value={t('certificates.rfc3161HashAlgoValue')} />
              <VerifyBlock
                token={c.rfc3161Token || ''}
                contentHash={c.contentHash}
                tsaUrl={c.rfc3161Tsa || ''}
                parentLoading={loadingHeavyFields}
                onCopy={(cmd) => { Clipboard.setStringAsync(cmd); showDarkAlert(t('certificates.rfc3161CopiedTitle'), t('certificates.rfc3161CopiedMsg')); }}
                onLoadToken={async () => {
                  try {
                    // Try disk first
                    const diskData = await NFTOperations.getCertificateFullData(c.id, c);
                    if (diskData?.rfc3161Token || diskData?.c2paManifest) {
                      setSelectedCert(prev => prev?.id === c.id ? ({ ...prev, ...diskData }) : prev);
                      return true;
                    }
                    const serverData = await fetchFullCertificateFromServer(c);
                    if (serverData?.rfc3161Token || serverData?.c2paManifest) {
                      setSelectedCert(prev => prev?.id === c.id ? ({ ...prev, ...serverData }) : prev);
                      return true;
                    }
                    // IPFS fallback
                    const updates = await loadTokenFromIPFS(c);
                    if (updates) {
                      setSelectedCert(prev => prev?.id === c.id ? ({ ...prev, ...updates }) : prev);
                      return true;
                    }
                  } catch (e) {
                    console.warn('[Certs] Token load failed:', e?.message);
                  }
                  return false;
                }}
              />
            </>
          )}
          {(c.hasC2pa || c.c2paManifest) && (
            <>
              <View style={styles.detailDivider} />
              <Text style={styles.detailSectionTitle}>{t('certificates.c2paTitle')}</Text>
              <DetailRow label={t('certificates.c2paStandard')} value={t('certificates.c2paStandardValue')} />
              <DetailRow label={t('certificates.c2paClaimGenerator')} value={c.c2paManifest?.claim_generator || `PhotoLynk/${Application.nativeApplicationVersion || '2.0.0'}`} />
              <DetailRow label={t('certificates.c2paCreated')} value={c.c2paManifest?.claim?.created || c.issuedAt || 'N/A'} />
            </>
          )}

          {/* Integrity Score */}
          <View style={styles.detailDivider} />
          <Text style={styles.detailSectionTitle}>{t('certificates.integrityScore') || 'Integrity Verification'}</Text>
          <View style={{ backgroundColor: 'rgba(16,185,129,0.06)', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: 'rgba(16,185,129,0.2)', marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Feather name="shield" size={20} color="#10b981" />
              <Text style={{ fontSize: 16, fontWeight: '700', color: '#10b981' }}>{t('certificates.integrityVerified') || 'Integrity: Verified'}</Text>
            </View>
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Feather name={c.contentHash ? 'check-circle' : 'minus-circle'} size={14} color={c.contentHash ? '#10b981' : '#6b7280'} />
                <Text style={{ fontSize: 12, color: c.contentHash ? '#10b981' : '#6b7280' }}>{t('certificates.hashAnchored') || 'Cryptographic hash anchored'}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Feather name={c.hasRfc3161 ? 'check-circle' : 'minus-circle'} size={14} color={c.hasRfc3161 ? '#10b981' : '#6b7280'} />
                <Text style={{ fontSize: 12, color: c.hasRfc3161 ? '#10b981' : '#6b7280' }}>{t('certificates.timestampVerified') || 'Timestamp authority verified (RFC 3161)'}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Feather name={c.hasC2pa ? 'check-circle' : 'minus-circle'} size={14} color={c.hasC2pa ? '#10b981' : '#6b7280'} />
                <Text style={{ fontSize: 12, color: c.hasC2pa ? '#10b981' : '#6b7280' }}>{t('certificates.contentAuthenticity') || 'Content authenticity signed (C2PA)'}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Feather name="check-circle" size={14} color="#10b981" />
                <Text style={{ fontSize: 12, color: '#10b981' }}>{t('certificates.immutableRecord') || 'Immutable on-chain record'}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Feather name={c.exifHash ? 'check-circle' : 'minus-circle'} size={14} color={c.exifHash ? '#10b981' : '#6b7280'} />
                <Text style={{ fontSize: 12, color: c.exifHash ? '#10b981' : '#6b7280' }}>{t('certificates.metadataIntact') || 'Original metadata intact'}</Text>
              </View>
            </View>
          </View>

          {/* Navigate to original in vault */}
          {onShowNFT && c.mintAddress && (
            <>
              <View style={styles.detailDivider} />
              {/* View in Photo Album button — matches Transfer button style */}
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,153,255,0.15)', borderRadius: 10, paddingVertical: 12, marginTop: 16, gap: 8 }}
                activeOpacity={0.7}
                onPress={() => onShowNFT(c.mintAddress)}
              >
                <Feather name="image" size={16} color="#0099FF" />
                <Text style={{ color: '#0099FF', fontWeight: '600', fontSize: 14 }}>{t('certificates.viewInVault') || 'View in Photo Album'}</Text>
              </TouchableOpacity>
            </>
          )}

        </View>
        </ScrollView>
      </View>
    );
  };

  // Handle Android back button
  useEffect(() => {
    if (!visible) return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectedCert) { setSelectedCert(null); return true; }
      onClose(); return true;
    });
    return () => handler.remove();
  }, [visible, selectedCert, onClose]);

  if (!visible) return null;

  const totalPages = Math.max(1, Math.ceil(certificates.length / PAGE_SIZE));
  const hasPrevPage = currentPage > 0;
  const hasNextPage = currentPage < totalPages - 1;

  return (
    <View style={styles.fullOverlay}>
      <StatusBar backgroundColor="transparent" barStyle="light-content" translucent />
      <View style={[styles.container, { paddingBottom: bottomInset }]}>
        <View style={[styles.header, { paddingTop: headerTopInset }]}>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Feather name="x" size={24} color={COLORS.text} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>{t('certificates.title')}</Text>
            <Text style={styles.headerSubtitle}>{certificates.length === 1 ? t('certificates.countLabelOne') : t('certificates.countLabel', { count: certificates.length })}</Text>
          </View>
          <View style={{ width: 40 }} />
        </View>

        {loadingDetail ? (
          <View style={styles.emptyState}>
            <ActivityIndicator size="large" color={COLORS.accent} />
            <Text style={{ color: COLORS.textSecondary, marginTop: 12, fontSize: 13 }}>{t('common.loading') || 'Loading...'}</Text>
          </View>
        ) : selectedCert ? (
          renderDetail()
        ) : loading ? (
          <View style={styles.emptyState}>
            <ActivityIndicator size="large" color={COLORS.accent} />
          </View>
        ) : certificates.length === 0 ? (
          <View style={styles.emptyState}>
            <Feather name="award" size={48} color={COLORS.textSecondary} />
            <Text style={styles.emptyTitle}>{t('certificates.noCertsYet')}</Text>
            <Text style={styles.emptySubtitle}>
              {t('certificates.noCertsHint')}
            </Text>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            {/* Page indicator */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: COLORS.border }}>
              <TouchableOpacity
                onPress={() => setCurrentPage(p => Math.max(0, p - 1))}
                disabled={!hasPrevPage}
                style={{ opacity: hasPrevPage ? 1 : 0.3, padding: 8 }}
              >
                <Feather name="chevron-left" size={20} color={COLORS.text} />
              </TouchableOpacity>
              <Text style={{ fontSize: 12, color: COLORS.textSecondary }}>
                {currentPage + 1}/{totalPages}
              </Text>
              <TouchableOpacity
                onPress={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={!hasNextPage}
                style={{ opacity: hasNextPage ? 1 : 0.3, padding: 8 }}
              >
                <Feather name="chevron-right" size={20} color={COLORS.text} />
              </TouchableOpacity>
            </View>
            <FlatList
              data={certificates.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)}
              keyExtractor={(item) => item.id}
              renderItem={renderCertCard}
              contentContainerStyle={[styles.listContent, { paddingBottom: 16 + bottomInset }]}
              showsVerticalScrollIndicator={false}
              removeClippedSubviews={true}
            />
          </View>
        )}
        {/* Dark Alert */}
        {darkAlert && (
          <View style={styles.darkAlertOverlay}>
            <View style={styles.darkAlertCard}>
              <Text style={styles.darkAlertTitle}>{darkAlert.title}</Text>
              <Text style={styles.darkAlertMessage}>{darkAlert.message}</Text>
              <View style={styles.darkAlertButtons}>
                {darkAlert.buttons.map((btn, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={[styles.darkAlertButton, idx === darkAlert.buttons.length - 1 && styles.darkAlertButtonPrimary]}
                    onPress={btn.onPress}
                  >
                    <Text style={[styles.darkAlertButtonText, idx === darkAlert.buttons.length - 1 && styles.darkAlertButtonTextPrimary]}>
                      {btn.text}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        )}
      </View>
    </View>
  );
};

const VerifyBlock = ({ token, contentHash, tsaUrl, onCopy, onLoadToken, parentLoading = false }) => {
  const [macExpanded, setMacExpanded] = React.useState(false);
  const [winExpanded, setWinExpanded] = React.useState(false);
  const [tokenLoading, setTokenLoading] = React.useState(false);
  const isLoading = tokenLoading || parentLoading;
  const hash = contentHash ? contentHash.replace(/^SHA256:/, '') : null;
  const step1mac = `printf '%s' "${token}" | base64 -d > token.tsr`;
  const step1win = `[System.Convert]::FromBase64String("${token}") | Set-Content token.tsr -Encoding Byte`;
  const isFreeTSA = !tsaUrl || tsaUrl.includes('freetsa.org');
  const step2 = isFreeTSA
    ? `curl -o cacert.pem https://freetsa.org/files/cacert.pem`
    : `# ${tsaUrl || 'TSA'} uses a publicly trusted CA — no custom cert needed`;
  const step2win = isFreeTSA
    ? `Invoke-WebRequest https://freetsa.org/files/cacert.pem -OutFile cacert.pem`
    : `# ${tsaUrl || 'TSA'} uses a publicly trusted CA — no custom cert needed`;
  const caFlag = isFreeTSA ? ' -CAfile cacert.pem' : '';
  const step3 = hash
    ? `openssl ts -verify -in token.tsr -digest ${hash}${caFlag}`
    : `openssl ts -verify -in token.tsr -digest <sha256_hash>${caFlag}`;

  // Auto-expand when token arrives after loading
  React.useEffect(() => {
    if (token && tokenLoading) {
      setTokenLoading(false);
      setMacExpanded(true);
    }
  }, [token]);

  const handleShowToggle = async (setExpanded, currentExpanded) => {
    if (!token && onLoadToken && !isLoading) {
      // Token not loaded yet — trigger loading
      setTokenLoading(true);
      const loaded = await onLoadToken();
      if (!loaded) setTokenLoading(false);
      // If loaded, the useEffect above will auto-expand when token prop updates
      return;
    }
    setExpanded(v => !v);
  };

  const CmdRow = ({ label, cmd, collapsible, expanded, onToggleExpand }) => (
    <View style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
        <Text style={{ fontSize: 9, color: '#10b981', fontWeight: '700' }}>{label}</Text>
        {collapsible && (
          <TouchableOpacity
            onPress={onToggleExpand}
            disabled={isLoading}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: isLoading ? 'rgba(107,114,128,0.12)' : 'rgba(16,185,129,0.12)' }}
          >
            {isLoading ? (
              <>
                <ActivityIndicator size={10} color="#10b981" />
                <Text style={{ fontSize: 9, color: '#6b7280' }}>{t('common.loading') || 'Loading...'}</Text>
              </>
            ) : (
              <>
                <Feather name={expanded ? 'eye-off' : 'eye'} size={10} color="#10b981" />
                <Text style={{ fontSize: 9, color: '#10b981' }}>{expanded ? t('certificates.collapse') || 'Hide' : t('certificates.expand') || 'Show'}</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>
      <TouchableOpacity
        onPress={() => onCopy(cmd)}
        activeOpacity={0.7}
      >
        <View style={{ backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 6, padding: 7, flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
          {collapsible && !expanded ? (
            <Text style={{ fontSize: 9, color: '#6b7280', fontFamily: 'monospace', flex: 1, fontStyle: 'italic' }}>
              {t('certificates.tokenHidden') || '(token hidden — tap Show to preview, tap row to copy)'}
            </Text>
          ) : (
            <Text style={{ fontSize: 9, color: '#a1a1aa', fontFamily: 'monospace', flex: 1 }} selectable>{cmd}</Text>
          )}
          <Feather name="copy" size={11} color="#10b981" style={{ marginTop: 1 }} />
        </View>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={{ marginTop: 6, padding: 10, backgroundColor: 'rgba(16,185,129,0.08)', borderRadius: 8, borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)' }}>
      <Text style={{ fontSize: 10, color: '#10b981', fontWeight: '700', marginBottom: 8 }}>{t('certificates.rfc3161VerifyLabel')}</Text>
      <Text style={{ fontSize: 9, color: '#6b7280', marginBottom: 6 }}>{t('certificates.macLinuxTerminal')}</Text>
      <CmdRow label={t('certificates.rfc3161Step1')} cmd={step1mac} collapsible expanded={macExpanded} onToggleExpand={() => handleShowToggle(setMacExpanded, macExpanded)} />
      <CmdRow label={t('certificates.rfc3161Step2')} cmd={step2} />
      <CmdRow label={t('certificates.rfc3161Step3')} cmd={step3} />
      <Text style={{ fontSize: 9, color: '#6b7280', marginTop: 6, marginBottom: 6 }}>{t('certificates.windowsPowershell')}</Text>
      <CmdRow label={t('certificates.rfc3161Step1')} cmd={step1win} collapsible expanded={winExpanded} onToggleExpand={() => handleShowToggle(setWinExpanded, winExpanded)} />
      <CmdRow label={t('certificates.rfc3161Step2')} cmd={step2win} />
      <CmdRow label={t('certificates.rfc3161Step3')} cmd={step3} />
      <Text style={{ fontSize: 9, color: '#6b7280', marginTop: 4 }}>{t('certificates.rfc3161Expected')}</Text>
    </View>
  );
};

const DetailRow = ({ label, value, mono }) => (
  <View style={styles.detailRow}>
    <Text style={styles.detailLabel}>{label}</Text>
    <Text style={[styles.detailValue, mono && styles.detailValueMono]} numberOfLines={1} ellipsizeMode="middle">
      {value}
    </Text>
  </View>
);

const styles = StyleSheet.create({
  fullOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    elevation: 9999,
    backgroundColor: COLORS.background,
  },
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight || 0 : 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  closeBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
  },
  headerSubtitle: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  listContent: {
    padding: 16,
    paddingBottom: 16,
    gap: 12,
  },
  detailScrollContent: {
    paddingBottom: 16,
  },
  certCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  certCardSelected: {
    borderColor: '#f59e0b',
  },
  certCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  certBadge: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  certCardInfo: {
    flex: 1,
  },
  certCardName: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.text,
  },
  certCardDate: {
    fontSize: 11,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  certCardActions: {
    flexDirection: 'row',
    gap: 8,
  },
  certIconBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  certCardMeta: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 10,
    flexWrap: 'wrap',
  },
  certTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
  certTagText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#f59e0b',
  },
  certMintAddr: {
    fontSize: 10,
    color: COLORS.textSecondary,
    fontFamily: 'monospace',
    marginTop: 8,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.text,
  },
  emptySubtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  detailContainer: {
    flex: 1,
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  detailBack: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
  },
  detailShareBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
  },
  detailCard: {
    margin: 16,
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  detailBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 4,
  },
  detailBadgeText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#f59e0b',
  },
  detailDivider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: 14,
  },
  detailSectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 10,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  detailLabel: {
    fontSize: 13,
    color: COLORS.textSecondary,
    flex: 0.4,
  },
  detailValue: {
    fontSize: 13,
    color: COLORS.text,
    fontWeight: '500',
    flex: 0.6,
    textAlign: 'right',
  },
  detailValueMono: {
    fontFamily: 'monospace',
    fontSize: 11,
  },
  darkAlertOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,1)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    zIndex: 9999,
    elevation: 9999,
  },
  darkAlertCard: {
    backgroundColor: '#0A0A14',
    borderRadius: 24,
    padding: 28,
    width: '100%',
    maxWidth: 340,
    borderWidth: 1.5,
    borderColor: 'rgba(167,139,250,0.15)',
  },
  darkAlertTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#F4F4F8',
    textAlign: 'center',
    marginBottom: 12,
  },
  darkAlertMessage: {
    fontSize: 14,
    color: '#9898B0',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  darkAlertButtons: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  darkAlertButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 14,
    backgroundColor: 'rgba(108,92,231,0.12)',
    borderWidth: 1.5,
    borderColor: 'rgba(108,92,231,0.35)',
    minWidth: 100,
  },
  darkAlertButtonPrimary: {
    backgroundColor: 'rgba(108,92,231,0.2)',
  },
  darkAlertButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#A78BFA',
    textAlign: 'center',
  },
  darkAlertButtonTextPrimary: {
    color: '#A78BFA',
  },
  verifyBox: {
    marginTop: 10,
    padding: 10,
    backgroundColor: 'rgba(245,158,11,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.15)',
    borderRadius: 8,
  },
  verifyTitle: {
    fontSize: 10,
    fontWeight: '700',
    color: '#f59e0b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  verifyText: {
    fontSize: 10,
    color: '#8888A0',
    lineHeight: 16,
    marginBottom: 4,
  },
  verifyBold: {
    fontWeight: '600',
    color: '#9898B0',
  },
  verifyCode: {
    fontFamily: 'monospace',
    color: '#f59e0b',
    fontSize: 10,
  },
  verifyCodeCopyable: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.3)',
    padding: 8,
    borderRadius: 4,
    marginVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.2)',
  },
  verifyCodeBlock: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: '#5C5C72',
    flex: 1,
    lineHeight: 14,
  },
  verifyNote: {
    fontSize: 9,
    color: '#4E4E66',
    marginTop: 4,
    lineHeight: 13,
  },
});

export default CertificatesViewer;
