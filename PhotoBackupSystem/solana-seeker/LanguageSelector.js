// PhotoLynk Language Selector Component
// Allows users to change app language with responsive text scaling

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  FlatList,
  StyleSheet,
  SafeAreaView,
  I18nManager,
} from 'react-native';
import { t, setLanguage, getCurrentLanguage, SUPPORTED_LANGUAGES, switchToEnglish } from './i18n';

const LanguageSelector = ({ visible, onClose, onLanguageChange }) => {
  const [currentLang, setCurrentLang] = useState(getCurrentLanguage());

  useEffect(() => {
    setCurrentLang(getCurrentLanguage());
  }, [visible]);

  const handleSelectLanguage = async (langCode) => {
    const success = await setLanguage(langCode);
    if (success) {
      setCurrentLang(langCode);
      onLanguageChange?.(langCode);
      onClose();
    }
  };

  const renderLanguageItem = ({ item }) => {
    const isSelected = item.code === currentLang;
    return (
      <TouchableOpacity
        style={[styles.languageItem, isSelected && styles.selectedItem]}
        onPress={() => handleSelectLanguage(item.code)}
        activeOpacity={0.7}
      >
        <Text style={styles.flag}>{item.flag}</Text>
        <View style={styles.languageTextContainer}>
          <Text 
            style={[styles.nativeName, isSelected && styles.selectedText]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
          >
            {item.nativeName}
          </Text>
          <Text 
            style={styles.englishName}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
          >
            {item.name}
          </Text>
        </View>
        {isSelected && <Text style={styles.checkmark}>✓</Text>}
      </TouchableOpacity>
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.modalContainer}>
        <View style={styles.modalContent}>
          <View style={styles.header}>
            <Text 
              style={styles.title}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
            >
              {t('settings.changeLanguage')}
            </Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeText}>✕</Text>
            </TouchableOpacity>
          </View>
          
          {/* Quick switch to English button - always visible in English */}
          {currentLang !== 'en' && (
            <TouchableOpacity
              style={styles.englishButton}
              onPress={() => handleSelectLanguage('en')}
            >
              <Text style={styles.englishButtonText}>🇬🇧 Switch to English</Text>
            </TouchableOpacity>
          )}

          <FlatList
            data={SUPPORTED_LANGUAGES}
            renderItem={renderLanguageItem}
            keyExtractor={(item) => item.code}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContent}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
};

// Compact language button for settings screen
export const LanguageButton = ({ onPress }) => {
  const currentLang = getCurrentLanguage();
  const langInfo = SUPPORTED_LANGUAGES.find(l => l.code === currentLang) || SUPPORTED_LANGUAGES[0];

  return (
    <TouchableOpacity style={styles.languageButton} onPress={onPress}>
      <Text style={styles.languageButtonFlag}>{langInfo.flag}</Text>
      <Text 
        style={styles.languageButtonText}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
      >
        {langInfo.nativeName}
      </Text>
      <Text style={styles.languageButtonArrow}>›</Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#030308',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: '80%',
    paddingBottom: 20,
    borderTopWidth: 1.5,
    borderTopColor: 'rgba(167,139,250,0.12)',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(167,139,250,0.08)',
  },
  title: {
    fontSize: 18,
    fontWeight: '900',
    color: '#EEEEF6',
    flex: 1,
  },
  closeButton: {
    padding: 8,
  },
  closeText: {
    fontSize: 20,
    color: '#5C5C72',
  },
  englishButton: {
    backgroundColor: '#6C5CE7',
    marginHorizontal: 16,
    marginTop: 12,
    padding: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  englishButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  languageItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 12,
    marginVertical: 4,
    backgroundColor: '#0A0A14',
  },
  selectedItem: {
    backgroundColor: 'rgba(108,92,231,0.08)',
    borderWidth: 1.5,
    borderColor: '#6C5CE7',
  },
  flag: {
    fontSize: 24,
    marginRight: 12,
  },
  languageTextContainer: {
    flex: 1,
  },
  nativeName: {
    fontSize: 16,
    fontWeight: '500',
    color: '#F4F4F8',
  },
  englishName: {
    fontSize: 13,
    color: '#5C5C72',
    marginTop: 2,
  },
  selectedText: {
    color: '#A78BFA',
  },
  checkmark: {
    fontSize: 18,
    color: '#A78BFA',
    fontWeight: 'bold',
  },
  // Language button styles
  languageButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0A0A14',
    padding: 14,
    borderRadius: 16,
  },
  languageButtonFlag: {
    fontSize: 22,
    marginRight: 10,
  },
  languageButtonText: {
    flex: 1,
    fontSize: 16,
    color: '#F4F4F8',
  },
  languageButtonArrow: {
    fontSize: 22,
    color: '#5C5C72',
  },
});

export default LanguageSelector;
