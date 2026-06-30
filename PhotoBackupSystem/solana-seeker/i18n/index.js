// PhotoLynk Multi-language Support
// Auto-detects device language, persists user preference, fallback to English
// Uses simple translation lookup without i18n-js to avoid make-plural dependency issues

import * as Localization from 'expo-localization';
import * as SecureStore from 'expo-secure-store';

// Import all translations
import en from './locales/en.json';
import uk from './locales/uk.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import es from './locales/es.json';
import it from './locales/it.json';
import bg from './locales/bg.json';
import cs from './locales/cs.json';
import el from './locales/el.json';
import enGB from './locales/en-GB.json';
import hr from './locales/hr.json';
import hu from './locales/hu.json';
import id from './locales/id.json';
import ptBR from './locales/pt-BR.json';
import ro from './locales/ro.json';
import pl from './locales/pl.json';
import pt from './locales/pt.json';
import ru from './locales/ru.json';
import da from './locales/da.json';
import nl from './locales/nl.json';
import fi from './locales/fi.json';
import no from './locales/no.json';
import sv from './locales/sv.json';
import tr from './locales/tr.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import zh from './locales/zh.json';
import ar from './locales/ar.json';
import et from './locales/et.json';
import lt from './locales/lt.json';
import lv from './locales/lv.json';
import hi from './locales/hi.json';

const nftMintHelperTranslations = {
  ar: { settings: 'الحماية والحقوق', selectedPhoto: 'الصورة المحددة', licenseDesc: 'اختر كيف يمكن للآخرين استخدام هذه الصورة المعتمدة أو مشاركتها.', costSummaryDesc: 'راجع التكلفة التقديرية للاعتماد قبل إنشاء الـNFT.' },
  bg: { settings: 'Защита и права', selectedPhoto: 'Избрана снимка', licenseDesc: 'Изберете как другите могат да използват или споделят тази сертифицирана снимка.', costSummaryDesc: 'Прегледайте приблизителната цена за сертифициране, преди да създадете NFT.' },
  cs: { settings: 'Ochrana a práva', selectedPhoto: 'Vybraná fotografie', licenseDesc: 'Vyberte, jak mohou ostatní tuto certifikovanou fotografii používat nebo sdílet.', costSummaryDesc: 'Před vytvořením NFT zkontrolujte odhadované náklady na certifikaci.' },
  da: { settings: 'Beskyttelse og rettigheder', selectedPhoto: 'Valgt foto', licenseDesc: 'Vælg hvordan andre må bruge eller dele dette certificerede foto.', costSummaryDesc: 'Gennemgå de anslåede certificeringsomkostninger før du opretter NFT’en.' },
  de: { settings: 'Schutz und Rechte', selectedPhoto: 'Ausgewähltes Foto', licenseDesc: 'Wählen Sie aus, wie andere dieses zertifizierte Foto verwenden oder teilen dürfen.', costSummaryDesc: 'Prüfen Sie die geschätzten Zertifizierungskosten, bevor Sie das NFT prägen.' },
  el: { settings: 'Προστασία και δικαιώματα', selectedPhoto: 'Επιλεγμένη φωτογραφία', licenseDesc: 'Επιλέξτε πώς μπορούν άλλοι να χρησιμοποιούν ή να μοιράζονται αυτή την πιστοποιημένη φωτογραφία.', costSummaryDesc: 'Ελέγξτε το εκτιμώμενο κόστος πιστοποίησης πριν δημιουργήσετε το NFT.' },
  en: { settings: 'Protection & rights', selectedPhoto: 'Selected photo', licenseDesc: 'Select how others can use or share this certified photo.', costSummaryDesc: 'Review the estimated certification cost before minting.' },
  'en-GB': { settings: 'Protection & rights', selectedPhoto: 'Selected photo', licenseDesc: 'Select how others can use or share this certified photo.', costSummaryDesc: 'Review the estimated certification cost before minting.' },
  es: { settings: 'Protección y derechos', selectedPhoto: 'Foto seleccionada', licenseDesc: 'Selecciona cómo pueden otros usar o compartir esta foto certificada.', costSummaryDesc: 'Revisa el coste estimado de la certificación antes de acuñar.' },
  et: { settings: 'Kaitse ja õigused', selectedPhoto: 'Valitud foto', licenseDesc: 'Vali, kuidas teised võivad seda sertifitseeritud fotot kasutada või jagada.', costSummaryDesc: 'Vaata hinnanguline sertifitseerimiskulu üle enne NFT loomist.' },
  fi: { settings: 'Suojaus ja oikeudet', selectedPhoto: 'Valittu kuva', licenseDesc: 'Valitse, miten muut voivat käyttää tai jakaa tämän varmennetun kuvan.', costSummaryDesc: 'Tarkista arvioitu varmennuskustannus ennen NFT:n luontia.' },
  fr: { settings: 'Protection et droits', selectedPhoto: 'Photo sélectionnée', licenseDesc: 'Choisissez comment d’autres peuvent utiliser ou partager cette photo certifiée.', costSummaryDesc: 'Vérifiez le coût estimé de la certification avant de créer le NFT.' },
  hi: { settings: 'सुरक्षा और अधिकार', selectedPhoto: 'चुनी गई फ़ोटो', licenseDesc: 'चुनें कि दूसरे इस प्रमाणित फ़ोटो का उपयोग या साझा कैसे कर सकते हैं।', costSummaryDesc: 'NFT बनाने से पहले प्रमाणन की अनुमानित लागत की समीक्षा करें।' },
  hr: { settings: 'Zaštita i prava', selectedPhoto: 'Odabrana fotografija', licenseDesc: 'Odaberite kako drugi mogu koristiti ili dijeliti ovu certificiranu fotografiju.', costSummaryDesc: 'Pregledajte procijenjeni trošak certifikacije prije stvaranja NFT-a.' },
  hu: { settings: 'Védelem és jogok', selectedPhoto: 'Kiválasztott fotó', licenseDesc: 'Válaszd ki, hogyan használhatják vagy oszthatják meg mások ezt a hitelesített fotót.', costSummaryDesc: 'Tekintsd át a becsült hitelesítési költséget az NFT létrehozása előtt.' },
  id: { settings: 'Perlindungan & hak', selectedPhoto: 'Foto terpilih', licenseDesc: 'Pilih bagaimana orang lain dapat menggunakan atau membagikan foto tersertifikasi ini.', costSummaryDesc: 'Tinjau perkiraan biaya sertifikasi sebelum membuat NFT.' },
  it: { settings: 'Protezione e diritti', selectedPhoto: 'Foto selezionata', licenseDesc: 'Seleziona come altri possono usare o condividere questa foto certificata.', costSummaryDesc: 'Controlla il costo stimato della certificazione prima di coniare l’NFT.' },
  ja: { settings: '保護と権利', selectedPhoto: '選択した写真', licenseDesc: 'この認証済み写真を他の人がどのように使用または共有できるかを選択してください。', costSummaryDesc: 'NFT を作成する前に、認証の見積費用を確認してください。' },
  ko: { settings: '보호 및 권리', selectedPhoto: '선택한 사진', licenseDesc: '다른 사람이 이 인증된 사진을 어떻게 사용하거나 공유할 수 있는지 선택하세요.', costSummaryDesc: 'NFT를 만들기 전에 예상 인증 비용을 확인하세요.' },
  lt: { settings: 'Apsauga ir teisės', selectedPhoto: 'Pasirinkta nuotrauka', licenseDesc: 'Pasirinkite, kaip kiti gali naudoti ar bendrinti šią sertifikuotą nuotrauką.', costSummaryDesc: 'Prieš kurdami NFT peržiūrėkite numatomą sertifikavimo kainą.' },
  lv: { settings: 'Aizsardzība un tiesības', selectedPhoto: 'Atlasītais foto', licenseDesc: 'Izvēlieties, kā citi var izmantot vai kopīgot šo sertificēto fotoattēlu.', costSummaryDesc: 'Pārskatiet aptuvenās sertificēšanas izmaksas pirms NFT izveides.' },
  nl: { settings: 'Bescherming en rechten', selectedPhoto: 'Geselecteerde foto', licenseDesc: 'Kies hoe anderen deze gecertificeerde foto mogen gebruiken of delen.', costSummaryDesc: 'Controleer de geschatte certificeringskosten voordat je het NFT mint.' },
  no: { settings: 'Beskyttelse og rettigheter', selectedPhoto: 'Valgt bilde', licenseDesc: 'Velg hvordan andre kan bruke eller dele dette sertifiserte bildet.', costSummaryDesc: 'Se gjennom den estimerte sertifiseringskostnaden før du oppretter NFT-en.' },
  pl: { settings: 'Ochrona i prawa', selectedPhoto: 'Wybrane zdjęcie', licenseDesc: 'Wybierz, w jaki sposób inni mogą używać lub udostępniać to certyfikowane zdjęcie.', costSummaryDesc: 'Sprawdź szacowany koszt certyfikacji przed utworzeniem NFT.' },
  pt: { settings: 'Proteção e direitos', selectedPhoto: 'Foto selecionada', licenseDesc: 'Selecione como outras pessoas podem usar ou partilhar esta foto certificada.', costSummaryDesc: 'Reveja o custo estimado da certificação antes de criar o NFT.' },
  'pt-BR': { settings: 'Proteção e direitos', selectedPhoto: 'Foto selecionada', licenseDesc: 'Selecione como outras pessoas podem usar ou compartilhar esta foto certificada.', costSummaryDesc: 'Revise o custo estimado da certificação antes de cunhar.' },
  ro: { settings: 'Protecție și drepturi', selectedPhoto: 'Fotografie selectată', licenseDesc: 'Alegeți cum pot alții să utilizeze sau să distribuie această fotografie certificată.', costSummaryDesc: 'Verificați costul estimat al certificării înainte de a crea NFT-ul.' },
  ru: { settings: 'Защита и права', selectedPhoto: 'Выбранное фото', licenseDesc: 'Выберите, как другие могут использовать или делиться этой сертифицированной фотографией.', costSummaryDesc: 'Проверьте примерную стоимость сертификации перед созданием NFT.' },
  sv: { settings: 'Skydd och rättigheter', selectedPhoto: 'Valt foto', licenseDesc: 'Välj hur andra får använda eller dela detta certifierade foto.', costSummaryDesc: 'Granska den uppskattade certifieringskostnaden innan du skapar NFT:n.' },
  tr: { settings: 'Koruma ve haklar', selectedPhoto: 'Seçilen fotoğraf', licenseDesc: 'Başkalarının bu sertifikalı fotoğrafı nasıl kullanabileceğini veya paylaşabileceğini seçin.', costSummaryDesc: 'NFT’yi oluşturmadan önce tahmini sertifikasyon maliyetini inceleyin.' },
  uk: { settings: 'Захист і права', selectedPhoto: 'Вибране фото', licenseDesc: 'Оберіть, як інші можуть використовувати або поширювати це сертифіковане фото.', costSummaryDesc: 'Перегляньте орієнтовну вартість сертифікації перед створенням NFT.' },
  zh: { settings: '保护与权利', selectedPhoto: '已选择的照片', licenseDesc: '选择其他人如何使用或分享这张已认证的照片。', costSummaryDesc: '在创建 NFT 之前，请查看预计认证费用。' },
};

const withNftMintHelpers = (localeCode, localeData) => ({
  ...localeData,
  nftMint: {
    ...(localeData?.nftMint || {}),
    ...(nftMintHelperTranslations[localeCode] || {}),
  },
});

// All translations indexed by language code
const translations = {
  en: withNftMintHelpers('en', en),
  uk: withNftMintHelpers('uk', uk),
  fr: withNftMintHelpers('fr', fr),
  de: withNftMintHelpers('de', de),
  es: withNftMintHelpers('es', es),
  it: withNftMintHelpers('it', it),
  bg: withNftMintHelpers('bg', bg),
  cs: withNftMintHelpers('cs', cs),
  el: withNftMintHelpers('el', el),
  'en-GB': withNftMintHelpers('en-GB', enGB),
  hr: withNftMintHelpers('hr', hr),
  hu: withNftMintHelpers('hu', hu),
  id: withNftMintHelpers('id', id),
  'pt-BR': withNftMintHelpers('pt-BR', ptBR),
  ro: withNftMintHelpers('ro', ro),
  pl: withNftMintHelpers('pl', pl),
  pt: withNftMintHelpers('pt', pt),
  ru: withNftMintHelpers('ru', ru),
  da: withNftMintHelpers('da', da),
  nl: withNftMintHelpers('nl', nl),
  fi: withNftMintHelpers('fi', fi),
  no: withNftMintHelpers('no', no),
  sv: withNftMintHelpers('sv', sv),
  tr: withNftMintHelpers('tr', tr),
  ja: withNftMintHelpers('ja', ja),
  ko: withNftMintHelpers('ko', ko),
  zh: withNftMintHelpers('zh', zh),
  ar: withNftMintHelpers('ar', ar),
  et: withNftMintHelpers('et', et),
  lt: withNftMintHelpers('lt', lt),
  lv: withNftMintHelpers('lv', lv),
  hi: withNftMintHelpers('hi', hi),
};

// Current language state
let currentLocale = 'en';

// Language metadata for UI display
export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English', flag: '🇬🇧' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська', flag: '🇺🇦' },
  { code: 'fr', name: 'French', nativeName: 'Français', flag: '🇫🇷' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', flag: '🇩🇪' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', flag: '🇪🇸' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', flag: '🇮🇹' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski', flag: '🇵🇱' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', flag: '🇵🇹' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', flag: '🇷🇺' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk', flag: '🇩🇰' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', flag: '🇳🇱' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi', flag: '🇫🇮' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk', flag: '🇳🇴' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska', flag: '🇸🇪' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', flag: '🇹🇷' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', flag: '🇯🇵' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', flag: '🇰🇷' },
  { code: 'zh', name: 'Chinese', nativeName: '中文', flag: '🇨🇳' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', flag: '🇸🇦', rtl: true },
  { code: 'et', name: 'Estonian', nativeName: 'Eesti', flag: '🇪🇪' },
  { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių', flag: '🇱🇹' },
  { code: 'lv', name: 'Latvian', nativeName: 'Latviešu', flag: '🇱🇻' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', flag: '🇮🇳' },
];

// Storage key for persisted language preference (true = use English, false/null = use system)
const USE_ENGLISH_KEY = 'app_use_english';

// Check if language is supported
const isSupported = (code) => {
  return SUPPORTED_LANGUAGES.some(lang => lang.code === code);
};

// Get device locale code (e.g., 'en', 'fr', 'de')
let _localeLoggedOnce = false;
const getDeviceLocale = () => {
  // Use getLocales() function to get FRESH locale data (not cached static properties)
  // This ensures we detect language changes after app restart
  let locales = [];
  try {
    locales = Localization.getLocales() || [];
  } catch (e) {
    // Fallback to static properties if getLocales() fails
    locales = Localization.locales || [];
  }
  
  // Also try static locale as fallback
  const staticLocale = Localization.locale || '';
  
  // Log raw values only on first call to avoid flooding the console
  if (!_localeLoggedOnce) {
    _localeLoggedOnce = true;
    console.log(`[i18n] Raw locale: "${staticLocale}", getLocales(): ${JSON.stringify(locales?.slice(0, 3))}`);
  }
  
  // Try getLocales() array first (most reliable, returns fresh data)
  if (locales && locales.length > 0) {
    for (const loc of locales) {
      const locStr = typeof loc === 'string' ? loc : loc?.languageCode || loc?.languageTag || '';
      const code = locStr.split(/[-_]/)[0].toLowerCase();
      if (code && isSupported(code)) {
        return code;
      }
    }
    // Return first locale even if not supported
    const firstLoc = locales[0];
    const firstCode = typeof firstLoc === 'string' ? firstLoc : firstLoc?.languageCode || firstLoc?.languageTag || '';
    if (firstCode) {
      return firstCode.split(/[-_]/)[0].toLowerCase();
    }
  }
  
  // Fallback to static locale property
  if (staticLocale) {
    const code = staticLocale.split(/[-_]/)[0].toLowerCase();
    if (code && isSupported(code)) {
      return code;
    }
    return code || 'en';
  }
  
  return 'en';
};

// Get system language (returns 'en' if system language is not supported)
export const getSystemLanguage = () => {
  const deviceLocale = getDeviceLocale();
  return isSupported(deviceLocale) ? deviceLocale : 'en';
};

// Check if user has forced English mode
let useEnglishMode = false;

// Initialize language - call this on app start
// Defaults to English, user can enable system language via toggle (when available)
export const initializeLanguage = async () => {
  try {
    // Clear any old language preference keys from previous versions
    try {
      await SecureStore.deleteItemAsync('app_language');
      await SecureStore.deleteItemAsync('selected_language');
    } catch (e) { /* ignore */ }
    
    // Check if user has enabled system language mode (default is English)
    const savedUseEnglish = await SecureStore.getItemAsync(USE_ENGLISH_KEY);
    // Default to English (true) unless explicitly set to false
    useEnglishMode = savedUseEnglish !== 'false';
    
    if (useEnglishMode) {
      currentLocale = 'en';
      console.log(`[i18n] Using English (default)`);
      return 'en';
    }
    
    // Only use system language if user explicitly disabled English mode
    const systemLang = getSystemLanguage();
    currentLocale = systemLang;
    console.log(`[i18n] Using system language: ${systemLang}`);
    return systemLang;
  } catch (e) {
    console.log('[i18n] Error initializing language:', e);
    currentLocale = 'en';
    return 'en';
  }
};

// Toggle between English and System language
export const setUseEnglish = async (useEnglish) => {
  try {
    useEnglishMode = useEnglish;
    await SecureStore.setItemAsync(USE_ENGLISH_KEY, useEnglish ? 'true' : 'false');
    
    if (useEnglish) {
      currentLocale = 'en';
      console.log(`[i18n] Switched to English`);
    } else {
      currentLocale = getSystemLanguage();
      console.log(`[i18n] Switched to system language: ${currentLocale}`);
    }
    return true;
  } catch (e) {
    console.log('[i18n] Error saving language preference:', e);
    return false;
  }
};

// Check if using English mode (vs system language)
export const isUsingEnglish = () => {
  return useEnglishMode;
};

// Change language directly (for backwards compatibility)
export const setLanguage = async (code) => {
  if (code === 'en') {
    return setUseEnglish(true);
  } else {
    // If setting to system language, disable English mode
    return setUseEnglish(false);
  }
};

// Quick switch to English (accessible from any language)
export const switchToEnglish = async () => {
  return setUseEnglish(true);
};

// Get current language code
export const getCurrentLanguage = () => {
  return currentLocale;
};

// Get language info
export const getLanguageInfo = (code) => {
  return SUPPORTED_LANGUAGES.find(lang => lang.code === code);
};

// Check if current language is RTL
export const isRTL = () => {
  const lang = getLanguageInfo(currentLocale);
  return lang?.rtl || false;
};

// Translation function - simple key lookup with fallback to English
// Supports English pluralization via _one/_other suffixes when count is provided
export const t = (key, options = {}) => {
  const keys = key.split('.');
  const lastKey = keys[keys.length - 1];
  
  // For English, check for plural forms when count is provided
  const count = options.count;
  const needsPlural = currentLocale === 'en' && typeof count === 'number';
  
  // Try plural key first for English (e.g., filesOnServer_one or filesOnServer_other)
  const pluralSuffix = count === 1 ? '_one' : '_other';
  const keysToTry = needsPlural ? [
    [...keys.slice(0, -1), lastKey + pluralSuffix],
    keys
  ] : [keys];
  
  let value = null;
  
  for (const tryKeys of keysToTry) {
    value = translations[currentLocale];
    let found = true;
    
    // Navigate nested keys
    for (const k of tryKeys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        found = false;
        break;
      }
    }
    
    if (found && typeof value === 'string') break;
    
    // Fallback to English
    value = translations.en;
    found = true;
    for (const k2 of tryKeys) {
      if (value && typeof value === 'object' && k2 in value) {
        value = value[k2];
      } else {
        found = false;
        break;
      }
    }
    
    if (found && typeof value === 'string') break;
    value = null;
  }
  
  if (!value || typeof value !== 'string') return key;
  
  // Handle interpolation (e.g., {{count}})
  if (options) {
    for (const [optKey, optVal] of Object.entries(options)) {
      value = value.replace(new RegExp(`{{${optKey}}}`, 'g'), String(optVal));
    }
  }
  
  return value;
};

// Export translations for direct access if needed
export { translations };
