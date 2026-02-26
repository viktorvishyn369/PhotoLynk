const fs = require("fs");
const path = require("path");

const translations = {
    "ar": ["جاري طلب الطابع الزمني الموثوق...", "جاري الرفع إلى التخزين الدائم...", "جاري تضمين الصورة الأصلية...", "جاري إنشاء سجل قياسي..."],
    "bg": ["Заявка за доверен времеви печат...", "Качване в постоянно хранилище...", "Вграждане на оригинално изображение...", "Създаване на стандартен запис..."],
    "cs": ["Žádost o důvěryhodné časové razítko...", "Nahrávání do trvalého úložiště...", "Vkládání původního obrázku...", "Vytváření standardního záznamu..."],
    "da": ["Anmoder om betroet tidsstempel...", "Uploader til permanent lager...", "Indlejrer originalt billede...", "Opretter standard optegnelse..."],
    "de": ["Vertrauenswürdiger Zeitstempel wird angefordert...", "Upload in permanenten Speicher...", "Originalbild wird eingebettet...", "Standardeintrag wird erstellt..."],
    "el": ["Αίτηση αξιόπιστης χρονοσφραγίδας...", "Μεταφόρτωση σε μόνιμη αποθήκευση...", "Ενσωμάτωση αρχικής εικόνας...", "Δημιουργία τυπικής εγγραφής..."],
    "en-GB": ["Requesting trusted timestamp...", "Uploading to permanent storage...", "Embedding original image...", "Creating standard record..."],
    "en": ["Requesting trusted timestamp...", "Uploading to permanent storage...", "Embedding original image...", "Creating standard record..."],
    "es": ["Solicitando marca de tiempo confiable...", "Subiendo a almacenamiento permanente...", "Incrustando imagen original...", "Creando registro estándar..."],
    "et": ["Usaldusväärse ajatempli päring...", "Üleslaadimine püsimällu...", "Algse pildi manustamine...", "Standardkirje loomine..."],
    "fi": ["Pyydetään luotettua aikaleimaa...", "Ladataan pysyvään tallennustilaan...", "Upotetaan alkuperäistä kuvaa...", "Luodaan vakiotietuetta..."],
    "fr": ["Demande d'horodatage de confiance...", "Téléversement vers le stockage permanent...", "Intégration de l'image originale...", "Création d'un enregistrement standard..."],
    "hi": ["विश्वसनीय टाइमस्टैम्प का अनुरोध...", "स्थायी भंडारण में अपलोड...", "मूल छवि एम्बेड करना...", "मानक रिकॉर्ड बनाना..."],
    "hr": ["Zahtjev za pouzdani vremenski žig...", "Prijenos u trajnu pohranu...", "Ugradnja izvorne slike...", "Stvaranje standardnog zapisa..."],
    "hu": ["Megbízható időbélyeg kérése...", "Feltöltés állandó tárhelyre...", "Eredeti kép beágyazása...", "Szabványos bejegyzés létrehozása..."],
    "id": ["Meminta cap waktu tepercaya...", "Mengunggah ke penyimpanan permanen...", "Menyematkan gambar asli...", "Membuat catatan standar..."],
    "it": ["Richiesta di marca temporale attendibile...", "Caricamento su archiviazione permanente...", "Incorporamento dell'immagine originale...", "Creazione record standard..."],
    "ja": ["信頼できるタイムスタンプを要求中...", "永久ストレージにアップロード中...", "オリジナル画像を埋め込み中...", "標準レコードを作成中..."],
    "ko": ["신뢰할 수 있는 타임스탬프 요청 중...", "영구 저장소에 업로드 중...", "원본 이미지 임베딩 중...", "표준 레코드 생성 중..."],
    "lt": ["Prašomas patikimas laiko žymeklis...", "Įkeliama į nuolatinę saugyklą...", "Įterpiamas originalus vaizdas...", "Kuriamas standartinis įrašas..."],
    "lv": ["Pieprasīts uzticams laika zīmogs...", "Augšupielāde pastāvīgā krātuvē...", "Oriģinālā attēla iegulšana...", "Standarta ieraksta izveide..."],
    "nl": ["Vertrouwd tijdstempel aanvragen...", "Uploaden naar permanente opslag...", "Originele afbeelding insluiten...", "Standaard record aanmaken..."],
    "no": ["Ber om pålitelig tidsstempel...", "Laster opp til permanent lagring...", "Bygger inn originalt bilde...", "Oppretter standard oppføring..."],
    "pl": ["Żądanie zaufanego znacznika czasu...", "Przesyłanie do trwałego magazynu...", "Osadzanie oryginalnego obrazu...", "Tworzenie standardowego rekordu..."],
    "pt-BR": ["Solicitando carimbo de data/hora confiável...", "Enviando para armazenamento permanente...", "Incorporando imagem original...", "Criando registro padrão..."],
    "pt": ["A solicitar carimbo temporal de confiança...", "A carregar para armazenamento permanente...", "A incorporar imagem original...", "A criar registo padrão..."],
    "ro": ["Se solicită marcaj temporal de încredere...", "Se încarcă în stocarea permanentă...", "Se încorporează imaginea originală...", "Se creează înregistrarea standard..."],
    "ru": ["Запрос доверенной метки времени...", "Загрузка в постоянное хранилище...", "Встраивание оригинального изображения...", "Создание стандартной записи..."],
    "sv": ["Begär betrodd tidsstämpel...", "Laddar upp till permanent lagring...", "Bäddar in originalbild...", "Skapar standardpost..."],
    "tr": ["Güvenilir zaman damgası isteniyor...", "Kalıcı depolamaya yükleniyor...", "Orijinal görsel yerleştiriliyor...", "Standart kayıt oluşturuluyor..."],
    "uk": ["Запит довіреної мітки часу...", "Завантаження до постійного сховища...", "Вбудовування оригінального зображення...", "Створення стандартного запису..."],
    "zh": ["请求可信时间戳...", "上传至永久存储...", "嵌入原始图片...", "创建标准记录..."]
};

const dirs = [
    path.join(__dirname, "PhotoBackupSystem", "solana-seeker", "i18n", "locales"),
    path.join(__dirname, "PhotoBackupSystem", "mobile-v2", "i18n", "locales")
];

for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
        console.log("Directory not found:", dir);
        continue;
    }
    
    for (const [lang, vals] of Object.entries(translations)) {
        const fpath = path.join(dir, lang + ".json");
        if (!fs.existsSync(fpath)) {
            console.log("File not found:", fpath);
            continue;
        }
        
        let data = JSON.parse(fs.readFileSync(fpath, "utf8"));
        
        if (data.nftStatus) {
            // Check if already updated and has correct value
            if (data.nftStatus.requestingTimestamp === vals[0]) {
                continue;
            }
            
            // We want to insert them at the correct position or end of nftStatus
            // Since JSON.stringify preserves key insertion order, we can reconstruct the nftStatus object
            // to ensure they are at the bottom.
            const newNftStatus = {};
            for (const [k, v] of Object.entries(data.nftStatus)) {
                // Skip if they already exist so we can re-append them at the bottom
                if (["requestingTimestamp", "uploadingArweave", "embeddingOriginal", "mintingStandard"].includes(k)) {
                    continue;
                }
                newNftStatus[k] = v;
            }
            
            // Append new keys
            newNftStatus.requestingTimestamp = vals[0];
            newNftStatus.uploadingArweave = vals[1];
            newNftStatus.embeddingOriginal = vals[2];
            newNftStatus.mintingStandard = vals[3];
            
            data.nftStatus = newNftStatus;
            
            // Format with 2 spaces and trailing newline
            fs.writeFileSync(fpath, JSON.stringify(data, null, 2) + "\n");
            console.log(`Updated ${path.basename(dir)}/${lang}.json`);
        }
    }
}
console.log("Done");
