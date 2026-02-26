const fs = require("fs");
const path = require("path");

const missingKeys = [
  "connectingWallet",
  "connectWallet",
  "walletLoginDesc",
  "walletAuthFailed",
  "haveExistingAccount",
  "legacyMigrateTitle",
  "migrateAndConnect",
  "backToNewUser"
];

const translations = {
  "ar": {
    connectingWallet: "جاري الاتصال بالمحفظة...",
    connectWallet: "ربط المحفظة",
    walletLoginDesc: "سجل الدخول باستخدام محفظة Solana للأجهزة الخاصة بك. تقوم المقاييس الحيوية لجهازك بتأمين حسابك — لا حاجة لكلمة مرور.",
    walletAuthFailed: "فشلت مصادقة المحفظة",
    haveExistingAccount: "لدي حساب حالي",
    legacyMigrateTitle: "ربط الحساب الحالي بالمحفظة",
    migrateAndConnect: "التحقق وربط المحفظة",
    backToNewUser: "← مستخدم جديد؟ اربط المحفظة مباشرة"
  },
  "bg": {
    connectingWallet: "Свързване с портфейла...",
    connectWallet: "Свържи портфейл",
    walletLoginDesc: "Влезте с вашия хардуерен портфейл Solana. Биометричните данни на устройството ви защитават акаунта — не е нужна парола.",
    walletAuthFailed: "Удостоверяването на портфейла неуспешно",
    haveExistingAccount: "Имам съществуващ акаунт",
    legacyMigrateTitle: "Свържете съществуващ акаунт с портфейл",
    migrateAndConnect: "Потвърди и Свържи Портфейл",
    backToNewUser: "← Нов потребител? Свържете портфейла директно"
  },
  "cs": {
    connectingWallet: "Připojování peněženky...",
    connectWallet: "Připojit peněženku",
    walletLoginDesc: "Přihlaste se pomocí hardwarové peněženky Solana. Biometrika vašeho zařízení zabezpečuje účet — nepotřebujete heslo.",
    walletAuthFailed: "Ověření peněženky selhalo",
    haveExistingAccount: "Mám existující účet",
    legacyMigrateTitle: "Propojit existující účet s peněženkou",
    migrateAndConnect: "Ověřit a Připojit peněženku",
    backToNewUser: "← Nový uživatel? Připojte peněženku přímo"
  },
  "da": {
    connectingWallet: "Forbinder wallet...",
    connectWallet: "Forbind Wallet",
    walletLoginDesc: "Log ind med din Solana hardware wallet. Din enheds biometri sikrer din konto — ingen adgangskode nødvendig.",
    walletAuthFailed: "Wallet-godkendelse fejlede",
    haveExistingAccount: "Jeg har en eksisterende konto",
    legacyMigrateTitle: "Knyt eksisterende konto til wallet",
    migrateAndConnect: "Bekræft og Forbind Wallet",
    backToNewUser: "← Ny bruger? Forbind wallet direkte"
  },
  "de": {
    connectingWallet: "Wallet wird verbunden...",
    connectWallet: "Wallet verbinden",
    walletLoginDesc: "Melden Sie sich mit Ihrer Solana-Hardware-Wallet an. Die Biometrie Ihres Geräts sichert Ihr Konto — kein Passwort erforderlich.",
    walletAuthFailed: "Wallet-Authentifizierung fehlgeschlagen",
    haveExistingAccount: "Ich habe ein bestehendes Konto",
    legacyMigrateTitle: "Bestehendes Konto mit Wallet verknüpfen",
    migrateAndConnect: "Verifizieren & Wallet verbinden",
    backToNewUser: "← Neuer Benutzer? Wallet direkt verbinden"
  },
  "el": {
    connectingWallet: "Σύνδεση πορτοφολιού...",
    connectWallet: "Σύνδεση Πορτοφολιού",
    walletLoginDesc: "Συνδεθείτε με το πορτοφόλι υλικού Solana. Τα βιομετρικά στοιχεία της συσκευής σας ασφαλίζουν τον λογαριασμό σας — δεν απαιτείται κωδικός.",
    walletAuthFailed: "Ο έλεγχος ταυτότητας πορτοφολιού απέτυχε",
    haveExistingAccount: "Έχω ήδη λογαριασμό",
    legacyMigrateTitle: "Σύνδεση υπάρχοντος λογαριασμού με πορτοφόλι",
    migrateAndConnect: "Επαλήθευση & Σύνδεση Πορτοφολιού",
    backToNewUser: "← Νέος χρήστης; Συνδέστε πορτοφόλι απευθείας"
  },
  "en-GB": {
    connectingWallet: "Connecting wallet...",
    connectWallet: "Connect Wallet",
    walletLoginDesc: "Sign in with your Solana hardware wallet. Your device biometrics secure your account — no password needed.",
    walletAuthFailed: "Wallet authentication failed",
    haveExistingAccount: "I have an existing account",
    legacyMigrateTitle: "Link existing account to wallet",
    migrateAndConnect: "Verify & Connect Wallet",
    backToNewUser: "← New user? Connect wallet directly"
  },
  "es": {
    connectingWallet: "Conectando billetera...",
    connectWallet: "Conectar Billetera",
    walletLoginDesc: "Inicie sesión con su billetera de hardware Solana. La biometría de su dispositivo asegura su cuenta: no necesita contraseña.",
    walletAuthFailed: "Fallo en la autenticación de la billetera",
    haveExistingAccount: "Tengo una cuenta existente",
    legacyMigrateTitle: "Vincular cuenta existente a la billetera",
    migrateAndConnect: "Verificar y Conectar Billetera",
    backToNewUser: "← ¿Usuario nuevo? Conecte la billetera directamente"
  },
  "et": {
    connectingWallet: "Rahakoti ühendamine...",
    connectWallet: "Ühenda Rahakott",
    walletLoginDesc: "Logi sisse oma Solana riistvaralise rahakotiga. Sinu seadme biomeetria turvab sinu kontot — parooli pole vaja.",
    walletAuthFailed: "Rahakoti autentimine ebaõnnestus",
    haveExistingAccount: "Mul on juba konto",
    legacyMigrateTitle: "Seo olemasolev konto rahakotiga",
    migrateAndConnect: "Kinnita ja Ühenda Rahakott",
    backToNewUser: "← Uus kasutaja? Ühenda rahakott otse"
  },
  "fi": {
    connectingWallet: "Yhdistetään lompakkoa...",
    connectWallet: "Yhdistä Lompakko",
    walletLoginDesc: "Kirjaudu sisään Solana-laitteistolompakollasi. Laitteesi biometriikka suojaa tiliäsi — salasanaa ei tarvita.",
    walletAuthFailed: "Lompakon todennus epäonnistui",
    haveExistingAccount: "Minulla on jo tili",
    legacyMigrateTitle: "Yhdistä olemassa oleva tili lompakkoon",
    migrateAndConnect: "Vahvista ja Yhdistä Lompakko",
    backToNewUser: "← Uusi käyttäjä? Yhdistä lompakko suoraan"
  },
  "fr": {
    connectingWallet: "Connexion du portefeuille...",
    connectWallet: "Connecter Portefeuille",
    walletLoginDesc: "Connectez-vous avec votre portefeuille matériel Solana. La biométrie de votre appareil sécurise votre compte — aucun mot de passe requis.",
    walletAuthFailed: "Échec de l'authentification du portefeuille",
    haveExistingAccount: "J'ai déjà un compte",
    legacyMigrateTitle: "Lier le compte existant au portefeuille",
    migrateAndConnect: "Vérifier et Connecter Portefeuille",
    backToNewUser: "← Nouvel utilisateur ? Connectez le portefeuille directement"
  },
  "hi": {
    connectingWallet: "वॉलेट कनेक्ट हो रहा है...",
    connectWallet: "वॉलेट कनेक्ट करें",
    walletLoginDesc: "अपने Solana हार्डवेयर वॉलेट से साइन इन करें। आपके डिवाइस के बायोमेट्रिक्स आपके खाते को सुरक्षित करते हैं — किसी पासवर्ड की आवश्यकता नहीं है।",
    walletAuthFailed: "वॉलेट प्रमाणीकरण विफल",
    haveExistingAccount: "मेरा पहले से खाता है",
    legacyMigrateTitle: "मौजूदा खाते को वॉलेट से लिंक करें",
    migrateAndConnect: "सत्यापित करें और वॉलेट कनेक्ट करें",
    backToNewUser: "← नए उपयोगकर्ता? सीधे वॉलेट कनेक्ट करें"
  },
  "hr": {
    connectingWallet: "Povezivanje novčanika...",
    connectWallet: "Poveži Novčanik",
    walletLoginDesc: "Prijavite se svojim Solana hardverskim novčanikom. Biometrija vašeg uređaja osigurava vaš račun — lozinka nije potrebna.",
    walletAuthFailed: "Autentifikacija novčanika nije uspjela",
    haveExistingAccount: "Imam postojeći račun",
    legacyMigrateTitle: "Poveži postojeći račun s novčanikom",
    migrateAndConnect: "Potvrdi i Poveži Novčanik",
    backToNewUser: "← Novi korisnik? Izravno povežite novčanik"
  },
  "hu": {
    connectingWallet: "Pénztárca csatlakoztatása...",
    connectWallet: "Pénztárca Csatlakoztatása",
    walletLoginDesc: "Jelentkezzen be Solana hardvertárcájával. Eszköze biometrikus adatai védik fiókját — nincs szükség jelszóra.",
    walletAuthFailed: "A pénztárca hitelesítése sikertelen",
    haveExistingAccount: "Már van fiókom",
    legacyMigrateTitle: "Meglévő fiók összekapcsolása pénztárcával",
    migrateAndConnect: "Ellenőrzés és Csatlakoztatás",
    backToNewUser: "← Új felhasználó? Csatlakoztassa a pénztárcát közvetlenül"
  },
  "id": {
    connectingWallet: "Menghubungkan dompet...",
    connectWallet: "Hubungkan Dompet",
    walletLoginDesc: "Masuk dengan dompet perangkat keras Solana Anda. Biometrik perangkat mengamankan akun Anda — tidak perlu kata sandi.",
    walletAuthFailed: "Autentikasi dompet gagal",
    haveExistingAccount: "Saya sudah punya akun",
    legacyMigrateTitle: "Tautkan akun yang ada ke dompet",
    migrateAndConnect: "Verifikasi & Hubungkan Dompet",
    backToNewUser: "← Pengguna baru? Langsung hubungkan dompet"
  },
  "it": {
    connectingWallet: "Connessione wallet...",
    connectWallet: "Connetti Wallet",
    walletLoginDesc: "Accedi con il tuo hardware wallet Solana. La biometria del tuo dispositivo protegge il tuo account — nessuna password necessaria.",
    walletAuthFailed: "Autenticazione wallet fallita",
    haveExistingAccount: "Ho già un account",
    legacyMigrateTitle: "Collega l'account esistente al wallet",
    migrateAndConnect: "Verifica e Connetti Wallet",
    backToNewUser: "← Nuovo utente? Connetti wallet direttamente"
  },
  "ja": {
    connectingWallet: "ウォレットに接続中...",
    connectWallet: "ウォレットを接続",
    walletLoginDesc: "Solanaハードウェアウォレットでサインインします。デバイスの生体認証でアカウントを保護します — パスワードは不要です。",
    walletAuthFailed: "ウォレット認証に失敗しました",
    haveExistingAccount: "すでにアカウントを持っています",
    legacyMigrateTitle: "既存のアカウントをウォレットにリンク",
    migrateAndConnect: "確認してウォレットを接続",
    backToNewUser: "← 新規ユーザーですか？直接ウォレットを接続"
  },
  "ko": {
    connectingWallet: "지갑 연결 중...",
    connectWallet: "지갑 연결",
    walletLoginDesc: "Solana 하드웨어 지갑으로 로그인하세요. 기기 생체 인식이 계정을 안전하게 보호합니다 — 비밀번호가 필요 없습니다.",
    walletAuthFailed: "지갑 인증 실패",
    haveExistingAccount: "기존 계정이 있습니다",
    legacyMigrateTitle: "기존 계정을 지갑에 연결",
    migrateAndConnect: "확인 및 지갑 연결",
    backToNewUser: "← 신규 사용자입니까? 직접 지갑 연결"
  },
  "lt": {
    connectingWallet: "Jungiama piniginė...",
    connectWallet: "Prijungti Piniginę",
    walletLoginDesc: "Prisijunkite su savo Solana aparatine pinigine. Jūsų įrenginio biometrija apsaugo jūsų paskyrą — slaptažodžio nereikia.",
    walletAuthFailed: "Piniginės autentifikavimas nepavyko",
    haveExistingAccount: "Turiu esamą paskyrą",
    legacyMigrateTitle: "Susieti esamą paskyrą su pinigine",
    migrateAndConnect: "Patvirtinti ir Prijungti Piniginę",
    backToNewUser: "← Naujas vartotojas? Prijunkite piniginę tiesiogiai"
  },
  "lv": {
    connectingWallet: "Maka savienošana...",
    connectWallet: "Pievienot Maku",
    walletLoginDesc: "Pierakstieties ar savu Solana aparatūras maku. Jūsu ierīces biometrija nodrošina jūsu kontu — parole nav nepieciešama.",
    walletAuthFailed: "Maka autentifikācija neizdevās",
    haveExistingAccount: "Man jau ir konts",
    legacyMigrateTitle: "Sasaistīt esošo kontu ar maku",
    migrateAndConnect: "Pārbaudīt un Pievienot Maku",
    backToNewUser: "← Jauns lietotājs? Pievienojiet maku tieši"
  },
  "nl": {
    connectingWallet: "Portemonnee verbinden...",
    connectWallet: "Portemonnee Verbinden",
    walletLoginDesc: "Meld u aan met uw Solana hardware wallet. De biometrie van uw apparaat beveiligt uw account — geen wachtwoord nodig.",
    walletAuthFailed: "Wallet-authenticatie mislukt",
    haveExistingAccount: "Ik heb al een account",
    legacyMigrateTitle: "Bestaand account aan wallet koppelen",
    migrateAndConnect: "Verifiëren & Wallet Verbinden",
    backToNewUser: "← Nieuwe gebruiker? Wallet direct verbinden"
  },
  "no": {
    connectingWallet: "Kobler til lommebok...",
    connectWallet: "Koble til Lommebok",
    walletLoginDesc: "Logg inn med din Solana maskinvare-lommebok. Enhetens biometri sikrer kontoen din — ingen passord er nødvendig.",
    walletAuthFailed: "Autentisering av lommebok mislyckades",
    haveExistingAccount: "Jeg har en eksisterende konto",
    legacyMigrateTitle: "Koble eksisterende konto til lommebok",
    migrateAndConnect: "Bekreft og Koble til Lommebok",
    backToNewUser: "← Ny bruker? Koble til lommebok direkte"
  },
  "pl": {
    connectingWallet: "Łączenie portfela...",
    connectWallet: "Połącz Portfel",
    walletLoginDesc: "Zaloguj się swoim portfelem sprzętowym Solana. Biometria Twojego urządzenia zabezpiecza Twoje konto — nie potrzeba hasła.",
    walletAuthFailed: "Uwierzytelnianie portfela nie powiodło się",
    haveExistingAccount: "Mam już konto",
    legacyMigrateTitle: "Połącz istniejące konto z portfelem",
    migrateAndConnect: "Zweryfikuj i Połącz Portfel",
    backToNewUser: "← Nowy użytkownik? Połącz portfel bezpośrednio"
  },
  "pt-BR": {
    connectingWallet: "Conectando carteira...",
    connectWallet: "Conectar Carteira",
    walletLoginDesc: "Faça login com sua carteira de hardware Solana. A biometria do seu dispositivo protege sua conta — não é necessária senha.",
    walletAuthFailed: "A autenticação da carteira falhou",
    haveExistingAccount: "Já tenho uma conta",
    legacyMigrateTitle: "Vincular conta existente à carteira",
    migrateAndConnect: "Verificar e Conectar Carteira",
    backToNewUser: "← Novo usuário? Conectar carteira diretamente"
  },
  "pt": {
    connectingWallet: "A ligar carteira...",
    connectWallet: "Ligar Carteira",
    walletLoginDesc: "Inicie sessão com a sua carteira de hardware Solana. A biometria do seu dispositivo protege a sua conta — sem necessidade de palavra-passe.",
    walletAuthFailed: "A autenticação da carteira falhou",
    haveExistingAccount: "Já tenho uma conta",
    legacyMigrateTitle: "Vincular conta existente à carteira",
    migrateAndConnect: "Verificar e Ligar Carteira",
    backToNewUser: "← Novo utilizador? Ligar carteira diretamente"
  },
  "ro": {
    connectingWallet: "Se conectează portofelul...",
    connectWallet: "Conectare Portofel",
    walletLoginDesc: "Conectați-vă cu portofelul hardware Solana. Biometria dispozitivului dvs. securizează contul — nu este nevoie de parolă.",
    walletAuthFailed: "Autentificarea portofelului a eșuat",
    haveExistingAccount: "Am un cont existent",
    legacyMigrateTitle: "Asociați contul existent la portofel",
    migrateAndConnect: "Verificare și Conectare Portofel",
    backToNewUser: "← Utilizator nou? Conectați portofelul direct"
  },
  "ru": {
    connectingWallet: "Подключение кошелька...",
    connectWallet: "Подключить кошелек",
    walletLoginDesc: "Войдите с помощью аппаратного кошелька Solana. Биометрия вашего устройства защищает вашу учетную запись — пароль не нужен.",
    walletAuthFailed: "Ошибка аутентификации кошелька",
    haveExistingAccount: "У меня уже есть аккаунт",
    legacyMigrateTitle: "Связать существующий аккаунт с кошельком",
    migrateAndConnect: "Подтвердить и подключить кошелек",
    backToNewUser: "← Новый пользователь? Подключите кошелек напрямую"
  },
  "sv": {
    connectingWallet: "Ansluter plånbok...",
    connectWallet: "Anslut Plånbok",
    walletLoginDesc: "Logga in med din Solana hårdvaruplånbok. Enhetens biometri säkrar ditt konto — inget lösenord behövs.",
    walletAuthFailed: "Autentisering av plånbok misslyckades",
    haveExistingAccount: "Jag har ett befintligt konto",
    legacyMigrateTitle: "Länka befintligt konto till plånbok",
    migrateAndConnect: "Verifiera och Anslut Plånbok",
    backToNewUser: "← Ny användare? Anslut plånbok direkt"
  },
  "tr": {
    connectingWallet: "Cüzdan bağlanıyor...",
    connectWallet: "Cüzdanı Bağla",
    walletLoginDesc: "Solana donanım cüzdanınızla giriş yapın. Cihazınızın biyometrisi hesabınızı güvenceye alır — şifreye gerek yoktur.",
    walletAuthFailed: "Cüzdan kimlik doğrulaması başarısız oldu",
    haveExistingAccount: "Mevcut bir hesabım var",
    legacyMigrateTitle: "Mevcut hesabı cüzdana bağla",
    migrateAndConnect: "Doğrula ve Cüzdanı Bağla",
    backToNewUser: "← Yeni kullanıcı mısınız? Doğrudan cüzdanı bağlayın"
  },
  "uk": {
    connectingWallet: "Підключення гаманця...",
    connectWallet: "Підключити гаманець",
    walletLoginDesc: "Увійдіть за допомогою апаратного гаманця Solana. Біометрія вашого пристрою захищає ваш обліковий запис — пароль не потрібен.",
    walletAuthFailed: "Помилка автентифікації гаманця",
    haveExistingAccount: "У мене вже є обліковий запис",
    legacyMigrateTitle: "Пов'язати існуючий обліковий запис з гаманцем",
    migrateAndConnect: "Підтвердити та підключити гаманець",
    backToNewUser: "← Новий користувач? Підключіть гаманець напряму"
  },
  "zh": {
    connectingWallet: "正在连接钱包...",
    connectWallet: "连接钱包",
    walletLoginDesc: "使用您的 Solana 硬件钱包登录。您的设备生物识别技术可保护您的帐户安全 — 无需密码。",
    walletAuthFailed: "钱包身份验证失败",
    haveExistingAccount: "已有账号",
    legacyMigrateTitle: "将现有帐户链接到钱包",
    migrateAndConnect: "验证并连接钱包",
    backToNewUser: "← 新用户？直接连接钱包"
  }
};

const dirs = [
    path.join(__dirname, "PhotoBackupSystem", "solana-seeker", "i18n", "locales"),
    path.join(__dirname, "PhotoBackupSystem", "mobile-v2", "i18n", "locales")
];

for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    
    for (const [lang, vals] of Object.entries(translations)) {
        const fpath = path.join(dir, lang + ".json");
        if (!fs.existsSync(fpath)) continue;
        
        let data = JSON.parse(fs.readFileSync(fpath, "utf8"));
        if (!data.auth) {
            data.auth = {};
        }
        
        let updated = false;
        for (const key of missingKeys) {
            if (data.auth[key] !== vals[key]) {
                data.auth[key] = vals[key];
                updated = true;
            }
        }
        
        if (updated) {
            fs.writeFileSync(fpath, JSON.stringify(data, null, 2) + "\n");
            console.log(`Updated ${path.basename(dir)}/${lang}.json`);
        }
    }
}
console.log("Done");
