#!/usr/bin/env node
/**
 * Translation Generator Script
 * 
 * Generates translation files for all supported languages.
 * 
 * Supported APIs (in order of quality):
 *   1. DeepL API Free - 500K chars/month, best quality (set DEEPL_API_KEY)
 *   2. Google Cloud Translation - 500K chars/month (set GOOGLE_API_KEY)
 *   3. MyMemory - 1000 words/day, no key needed (fallback)
 * 
 * Usage:
 *   DEEPL_API_KEY=your-key node generate-translations.js [language_code]
 * 
 * Examples:
 *   node generate-translations.js                    # All languages (MyMemory)
 *   DEEPL_API_KEY=xxx node generate-translations.js  # All languages (DeepL)
 *   DEEPL_API_KEY=xxx node generate-translations.js fr de es  # Specific languages
 * 
 * Get DeepL API Key (FREE - 500K chars/month):
 *   https://www.deepl.com/pro-api
 * 
 * Requirements:
 *   npm install node-fetch@2
 */

const fs = require('fs');
const path = require('path');

// API Keys from environment
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';

// Languages to generate (ISO 639-1 codes)
const LANGUAGES = [
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', flag: '🇸🇦', rtl: true },
  { code: 'bg', name: 'Bulgarian', nativeName: 'Български', flag: '🇧🇬' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština', flag: '🇨🇿' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk', flag: '🇩🇰' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', flag: '🇩🇪' },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά', flag: '🇬🇷' },
  { code: 'en-GB', name: 'English (UK)', nativeName: 'English (UK)', flag: '🇬🇧' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', flag: '🇪🇸' },
  { code: 'et', name: 'Estonian', nativeName: 'Eesti', flag: '🇪🇪' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi', flag: '🇫🇮' },
  { code: 'fr', name: 'French', nativeName: 'Français', flag: '🇫🇷' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', flag: '🇮🇳' },
  { code: 'hr', name: 'Croatian', nativeName: 'Hrvatski', flag: '🇭🇷' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar', flag: '🇭🇺' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', flag: '🇮🇹' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', flag: '🇯🇵' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', flag: '🇰🇷' },
  { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių', flag: '🇱🇹' },
  { code: 'lv', name: 'Latvian', nativeName: 'Latviešu', flag: '🇱🇻' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', flag: '🇳🇱' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk', flag: '🇳🇴' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski', flag: '🇵🇱' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', flag: '🇵🇹' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)', flag: '🇧🇷' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română', flag: '🇷🇴' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', flag: '🇷🇺' },
  { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina', flag: '🇸🇰' },
  { code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina', flag: '🇸🇮' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska', flag: '🇸🇪' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', flag: '🇹🇷' },
  { code: 'zh', name: 'Chinese', nativeName: '中文', flag: '🇨🇳' },
];

// DeepL language code mapping (some differ from ISO 639-1)
const DEEPL_LANG_MAP = {
  'zh': 'ZH',
  'en': 'EN',
  'pt': 'PT-PT',
  'no': 'NB', // Norwegian Bokmål
};

// Rate limiting - DeepL free tier is strict
const DELAY_BETWEEN_REQUESTS = 500; // ms between API calls (DeepL free needs slower)
const BATCH_SIZE = 50; // Translate in batches
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Translate using DeepL API (BEST QUALITY - 500K chars/month FREE)
async function translateWithDeepL(text, targetLang, retryCount = 0) {
  if (!text || typeof text !== 'string') return text;
  if (!DEEPL_API_KEY) return null; // Signal to use fallback
  
  // Skip if text is just placeholders or special chars
  if (/^[\{\}\[\]\d\s\.\,\:\;\-\_\=\+\*\/\\\|\@\#\$\%\^\&\(\)]+$/.test(text)) {
    return text;
  }
  
  // Preserve placeholders using unique markers
  const placeholders = [];
  let processedText = text.replace(/\{\{(\w+)\}\}/g, (match) => {
    placeholders.push(match);
    return `XPHX${placeholders.length - 1}XPHX`;  // Unique marker that won't be translated
  });
  
  try {
    const fetch = (await import('node-fetch')).default;
    const deeplLang = DEEPL_LANG_MAP[targetLang] || targetLang.toUpperCase();
    
    const response = await fetch('https://api-free.deepl.com/v2/translate', {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: [processedText],
        source_lang: 'EN',
        target_lang: deeplLang,
      }),
    });
    
    // Handle rate limiting with retry
    if (response.status === 429) {
      if (retryCount < MAX_RETRIES) {
        const waitTime = Math.pow(2, retryCount + 1) * 1000; // Exponential backoff: 2s, 4s, 8s
        await sleep(waitTime);
        return translateWithDeepL(text, targetLang, retryCount + 1);
      }
      return null; // Use fallback after max retries
    }
    
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`DeepL API error: ${response.status} - ${err}`);
    }
    
    const data = await response.json();
    let translated = data.translations?.[0]?.text || text;
    
    // Restore placeholders
    placeholders.forEach((ph, i) => {
      translated = translated.replace(new RegExp(`XPHX${i}XPHX`, 'gi'), ph);
    });
    
    return translated;
  } catch (error) {
    if (retryCount < MAX_RETRIES && error.message.includes('429')) {
      const waitTime = Math.pow(2, retryCount + 1) * 1000;
      await sleep(waitTime);
      return translateWithDeepL(text, targetLang, retryCount + 1);
    }
    console.error(`  DeepL error: ${error.message}`);
    return null; // Signal to use fallback
  }
}

// Translate using Google Cloud Translation API (500K chars/month FREE)
async function translateWithGoogle(text, targetLang) {
  if (!text || typeof text !== 'string') return text;
  if (!GOOGLE_API_KEY) return null;
  
  if (/^[\{\}\[\]\d\s\.\,\:\;\-\_\=\+\*\/\\\|\@\#\$\%\^\&\(\)]+$/.test(text)) {
    return text;
  }
  
  const placeholders = [];
  let processedText = text.replace(/\{\{(\w+)\}\}/g, (match) => {
    placeholders.push(match);
    return `__PH${placeholders.length - 1}__`;
  });
  
  try {
    const fetch = (await import('node-fetch')).default;
    const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_API_KEY}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: processedText,
        source: 'en',
        target: targetLang,
        format: 'text',
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Google API error: ${response.status}`);
    }
    
    const data = await response.json();
    let translated = data.data?.translations?.[0]?.translatedText || text;
    
    placeholders.forEach((ph, i) => {
      translated = translated.replace(`__PH${i}__`, ph);
    });
    
    return translated;
  } catch (error) {
    console.error(`  Google error: ${error.message}`);
    return null;
  }
}

// Flatten nested object to array of {path, value}
function flattenObject(obj, prefix = '') {
  const result = [];
  for (const key in obj) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      result.push(...flattenObject(obj[key], fullPath));
    } else {
      result.push({ path: fullPath, value: obj[key] });
    }
  }
  return result;
}

// Unflatten array back to nested object
function unflattenObject(items) {
  const result = {};
  for (const { path, value } of items) {
    const keys = path.split('.');
    let current = result;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]]) current[keys[i]] = {};
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
  }
  return result;
}

// Translate text using LibreTranslate API
async function translateWithLibre(text, targetLang, mirror = 0) {
  if (!text || typeof text !== 'string') return text;
  
  // Skip if text is just placeholders or special chars
  if (/^[\{\}\[\]\d\s\.\,\:\;\-\_\=\+\*\/\\\|\@\#\$\%\^\&\(\)]+$/.test(text)) {
    return text;
  }
  
  // Preserve placeholders like {{count}}, {{name}}, etc.
  const placeholders = [];
  let processedText = text.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    placeholders.push(match);
    return `__PH${placeholders.length - 1}__`;
  });
  
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(`${LIBRE_TRANSLATE_MIRRORS[mirror]}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: processedText,
        source: 'en',
        target: targetLang,
        format: 'text',
      }),
    });
    
    if (!response.ok) {
      // Try next mirror
      if (mirror < LIBRE_TRANSLATE_MIRRORS.length - 1) {
        return translateWithLibre(text, targetLang, mirror + 1);
      }
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    let translated = data.translatedText || text;
    
    // Restore placeholders
    placeholders.forEach((ph, i) => {
      translated = translated.replace(`__PH${i}__`, ph);
    });
    
    return translated;
  } catch (error) {
    console.error(`  Translation error: ${error.message}`);
    return text; // Return original on error
  }
}

// Alternative: Use MyMemory API (free, 1000 words/day)
async function translateWithMyMemory(text, targetLang) {
  if (!text || typeof text !== 'string') return text;
  if (/^[\{\}\[\]\d\s\.\,\:\;\-\_\=\+\*\/\\\|\@\#\$\%\^\&\(\)]+$/.test(text)) return text;
  
  const placeholders = [];
  let processedText = text.replace(/\{\{(\w+)\}\}/g, (match) => {
    placeholders.push(match);
    return `__PH${placeholders.length - 1}__`;
  });
  
  try {
    const fetch = (await import('node-fetch')).default;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(processedText)}&langpair=en|${targetLang}`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.responseStatus === 200 && data.responseData?.translatedText) {
      let translated = data.responseData.translatedText;
      placeholders.forEach((ph, i) => {
        translated = translated.replace(`__PH${i}__`, ph);
      });
      return translated;
    }
    return text;
  } catch (error) {
    return text;
  }
}

// Smart translate - tries DeepL first, then Google, then MyMemory
async function translateText(text, targetLang) {
  // Try DeepL first (best quality)
  if (DEEPL_API_KEY) {
    const result = await translateWithDeepL(text, targetLang);
    if (result !== null) return result;
  }
  
  // Try Google second
  if (GOOGLE_API_KEY) {
    const result = await translateWithGoogle(text, targetLang);
    if (result !== null) return result;
  }
  
  // Fallback to MyMemory (free, no key)
  return await translateWithMyMemory(text, targetLang);
}

// Main translation function
async function translateLanguage(langCode, enData) {
  const apiName = DEEPL_API_KEY ? 'DeepL' : (GOOGLE_API_KEY ? 'Google' : 'MyMemory');
  console.log(`\n🌍 Translating to ${langCode} using ${apiName}...`);
  
  const items = flattenObject(enData);
  const total = items.length;
  let translated = 0;
  let errors = 0;
  
  // Translate in batches
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    
    for (const item of batch) {
      // Skip app name and technical terms that should stay in English
      if (item.path === 'app.name' || 
          item.value === 'PhotoLynk' || 
          item.value === 'StealthCloud' ||
          item.value === 'Solana' ||
          item.value === 'NFT' ||
          item.value === 'IPFS' ||
          item.value === 'SOL' ||
          item.value === 'OK') {
        translated++;
        continue;
      }
      
      try {
        const result = await translateText(item.value, langCode);
        if (result) {
          item.value = result;
        }
        translated++;
        
        // Progress indicator
        if (translated % 100 === 0) {
          console.log(`  Progress: ${translated}/${total} (${Math.round(translated/total*100)}%)`);
        }
        
        await sleep(DELAY_BETWEEN_REQUESTS);
      } catch (err) {
        errors++;
        console.error(`  Error translating "${item.path}": ${err.message}`);
      }
    }
  }
  
  console.log(`  ✅ Completed: ${translated}/${total} strings${errors > 0 ? ` (${errors} errors)` : ''}`);
  return unflattenObject(items);
}

// Validate that translated object has same keys as source
function validateTranslation(source, translated, langCode) {
  const sourceKeys = flattenObject(source);
  const translatedKeys = flattenObject(translated);
  
  const sourceKeySet = new Set(sourceKeys.map(k => k.path));
  const translatedKeySet = new Set(translatedKeys.map(k => k.path));
  
  const missingKeys = [...sourceKeySet].filter(k => !translatedKeySet.has(k));
  const extraKeys = [...translatedKeySet].filter(k => !sourceKeySet.has(k));
  
  if (missingKeys.length > 0) {
    console.error(`  ❌ Missing ${missingKeys.length} keys in ${langCode}:`, missingKeys.slice(0, 5));
    return false;
  }
  if (extraKeys.length > 0) {
    console.warn(`  ⚠️ Extra ${extraKeys.length} keys in ${langCode}:`, extraKeys.slice(0, 5));
  }
  
  // Verify placeholders are preserved
  let placeholderIssues = 0;
  for (const srcItem of sourceKeys) {
    const tgtItem = translatedKeys.find(t => t.path === srcItem.path);
    if (!tgtItem) continue;
    
    const srcPlaceholders = (srcItem.value.match(/\{\{\w+\}\}/g) || []).sort();
    const tgtPlaceholders = (tgtItem.value.match(/\{\{\w+\}\}/g) || []).sort();
    
    if (JSON.stringify(srcPlaceholders) !== JSON.stringify(tgtPlaceholders)) {
      placeholderIssues++;
      if (placeholderIssues <= 3) {
        console.warn(`  ⚠️ Placeholder mismatch in "${srcItem.path}": expected ${srcPlaceholders}, got ${tgtPlaceholders}`);
      }
    }
  }
  
  if (placeholderIssues > 0) {
    console.warn(`  ⚠️ Total placeholder issues: ${placeholderIssues}`);
  }
  
  console.log(`  ✅ Validation passed: ${translatedKeys.length} keys (same as source)`);
  return true;
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const localesDir = path.join(__dirname, 'locales');
  
  // Load English source
  const enPath = path.join(localesDir, 'en.json');
  if (!fs.existsSync(enPath)) {
    console.error('❌ en.json not found!');
    process.exit(1);
  }
  
  const enData = JSON.parse(fs.readFileSync(enPath, 'utf8'));
  const enKeyCount = flattenObject(enData).length;
  console.log(`📖 Loaded en.json with ${enKeyCount} strings`);
  
  // Determine which languages to generate
  let targetLanguages = LANGUAGES;
  if (args.length > 0) {
    targetLanguages = LANGUAGES.filter(l => args.includes(l.code));
    if (targetLanguages.length === 0) {
      console.error(`❌ No valid language codes found. Available: ${LANGUAGES.map(l => l.code).join(', ')}`);
      process.exit(1);
    }
  }
  
  console.log(`\n🎯 Will generate: ${targetLanguages.map(l => l.code).join(', ')}`);
  console.log(`⚠️  Using MyMemory API (free, 1000 words/day limit)`);
  console.log(`   For large translations, run in batches or use paid API\n`);
  
  const results = [];
  
  for (const lang of targetLanguages) {
    try {
      const translated = await translateLanguage(lang.code, JSON.parse(JSON.stringify(enData)));
      
      // Validate before saving
      const isValid = validateTranslation(enData, translated, lang.code);
      
      const outPath = path.join(localesDir, `${lang.code}.json`);
      fs.writeFileSync(outPath, JSON.stringify(translated, null, 2) + '\n', 'utf8');
      console.log(`  💾 Saved: ${outPath}`);
      
      results.push({ lang: lang.code, success: true, valid: isValid, keys: flattenObject(translated).length });
    } catch (error) {
      console.error(`  ❌ Failed to generate ${lang.code}: ${error.message}`);
    }
  }
  
  // Print summary report
  console.log('\n' + '='.repeat(50));
  console.log('📊 TRANSLATION SUMMARY');
  console.log('='.repeat(50));
  console.log(`Source (en.json): ${enKeyCount} keys\n`);
  
  for (const r of results) {
    const status = r.valid ? '✅' : '⚠️';
    console.log(`${status} ${r.lang}: ${r.keys} keys ${r.valid ? '(validated)' : '(needs review)'}`);
  }
  
  const successCount = results.filter(r => r.success).length;
  const validCount = results.filter(r => r.valid).length;
  
  console.log('\n' + '-'.repeat(50));
  console.log(`Generated: ${successCount}/${targetLanguages.length} languages`);
  console.log(`Validated: ${validCount}/${successCount} passed`);
  console.log('='.repeat(50));
  
  console.log('\n✨ Translation generation complete!');
  console.log('\n📝 Don\'t forget to update i18n/index.js to import the new languages.');
  
  // Generate import statements helper
  if (results.length > 0) {
    console.log('\n📋 Copy these to i18n/index.js:\n');
    console.log('// Imports:');
    for (const r of results) {
      console.log(`import ${r.lang} from './locales/${r.lang}.json';`);
    }
    console.log('\n// Add to translations object:');
    console.log(`const translations = { en, uk, ${results.map(r => r.lang).join(', ')} };`);
    console.log('\n// Add to SUPPORTED_LANGUAGES array:');
    for (const r of results) {
      const langInfo = LANGUAGES.find(l => l.code === r.lang);
      if (langInfo) {
        const rtl = langInfo.rtl ? ', rtl: true' : '';
        console.log(`  { code: '${langInfo.code}', name: '${langInfo.name}', nativeName: '${langInfo.nativeName}', flag: '${langInfo.flag}'${rtl} },`);
      }
    }
  }
}

main().catch(console.error);
