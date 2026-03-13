#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
LOCALE_DIRS = [
    ROOT / 'PhotoBackupSystem' / 'solana-seeker' / 'i18n' / 'locales',
    ROOT / 'PhotoBackupSystem' / 'mobile-v2' / 'i18n' / 'locales',
]

PHOTO_PLURAL = {
    'ar': 'الصور',
    'bg': 'Снимки',
    'cs': 'Fotky',
    'da': 'Fotos',
    'de': 'Fotos',
    'el': 'Φωτογραφίες',
    'en': 'Photos',
    'en-GB': 'Photos',
    'es': 'Fotos',
    'et': 'Fotod',
    'fi': 'Valokuvat',
    'fr': 'Photos',
    'hi': 'फ़ोटो',
    'hr': 'Fotografije',
    'hu': 'Fotók',
    'id': 'Foto',
    'it': 'Foto',
    'ja': '写真',
    'ko': '사진',
    'lt': 'Nuotraukos',
    'lv': 'Fotogrāfijas',
    'nl': "Foto's",
    'no': 'Bilder',
    'pl': 'Zdjęcia',
    'pt': 'Fotos',
    'pt-BR': 'Fotos',
    'ro': 'Fotografii',
    'ru': 'Фото',
    'sv': 'Foton',
    'tr': 'Fotoğraflar',
    'uk': 'Фото',
    'zh': '照片',
}

NFT_TRANSFERRED = {
    'ar': 'تم نقل الصورة',
    'bg': 'Снимката е прехвърлена',
    'cs': 'Fotografie převedena',
    'da': 'Foto overført',
    'de': 'Foto übertragen',
    'el': 'Η φωτογραφία μεταφέρθηκε',
    'en': 'Photo transferred',
    'en-GB': 'Photo transferred',
    'es': 'Foto transferida',
    'et': 'Foto edastatud',
    'fi': 'Valokuva siirretty',
    'fr': 'Photo transférée',
    'hi': 'फ़ोटो स्थानांतरित',
    'hr': 'Fotografija prenesena',
    'hu': 'Fotó áthelyezve',
    'id': 'Foto ditransfer',
    'it': 'Foto trasferita',
    'ja': '写真を転送しました',
    'ko': '사진 전송됨',
    'lt': 'Nuotrauka perkelta',
    'lv': 'Fotogrāfija pārsūtīta',
    'nl': 'Foto overgedragen',
    'no': 'Bilde overført',
    'pl': 'Zdjęcie przeniesione',
    'pt': 'Foto transferida',
    'pt-BR': 'Foto transferida',
    'ro': 'Fotografie transferată',
    'ru': 'Фото передано',
    'sv': 'Foto överfört',
    'tr': 'Fotoğraf aktarıldı',
    'uk': 'Фото передано',
    'zh': '照片已转移',
}

VIEW_IN_PHOTOS_AND_PROOFS = {
    'ar': 'اعرض في الصور والإثباتات.',
    'bg': 'Вижте в Снимки и Доказателства.',
    'cs': 'Zobrazit ve Fotkách a Důkazech.',
    'da': 'Se i Fotos og Beviser.',
    'de': 'In Fotos und Beweisen anzeigen.',
    'el': 'Δείτε στις Φωτογραφίες και στις Αποδείξεις.',
    'en': 'View in Photos and Proofs.',
    'en-GB': 'View in Photos and Proofs.',
    'es': 'Ver en Fotos y Pruebas.',
    'et': 'Vaata jaotises Fotod ja Tõendid.',
    'fi': 'Katso kohdassa Valokuvat ja Todisteet.',
    'fr': 'Voir dans Photos et Preuves.',
    'hi': 'फ़ोटो और प्रमाण में देखें।',
    'hr': 'Pogledajte u Fotografije i Dokaze.',
    'hu': 'Megtekintés a Fotók és Bizonyítékok között.',
    'id': 'Lihat di Foto dan Bukti.',
    'it': 'Vedi in Foto e Prove.',
    'ja': '写真と証明で表示。',
    'ko': '사진 및 증명에서 보기.',
    'lt': 'Žiūrėti Nuotraukose ir Įrodymuose.',
    'lv': 'Skatīt Fotogrāfijās un Pierādījumos.',
    'nl': "Bekijk in Foto's en Bewijzen.",
    'no': 'Se i Bilder og Bevis.',
    'pl': 'Zobacz w Zdjęcia i Dowody.',
    'pt': 'Ver em Fotos e Provas.',
    'pt-BR': 'Ver em Fotos e Provas.',
    'ro': 'Vezi în Fotografii și Dovezi.',
    'ru': 'Смотрите в Фото и Доказательствах.',
    'sv': 'Visa i Foton och Bevis.',
    'tr': 'Fotoğraflar ve Kanıtlar bölümünde görüntüle.',
    'uk': 'Переглянути у Фото та Доказах.',
    'zh': '在照片和证明中查看。',
}

EMBEDDING_PHOTO = {
    'ar': 'جاري تضمين الصورة...',
    'bg': 'Вграждане на снимка...',
    'cs': 'Vkládání fotografie...',
    'da': 'Indlejrer foto...',
    'de': 'Foto wird eingebettet...',
    'el': 'Ενσωμάτωση φωτογραφίας...',
    'en': 'Embedding photo...',
    'en-GB': 'Embedding photo...',
    'es': 'Incrustando foto...',
    'et': 'Foto manustamine...',
    'fi': 'Upotetaan valokuvaa...',
    'fr': 'Intégration de la photo...',
    'hi': 'फ़ोटो एम्बेड की जा रही है...',
    'hr': 'Ugradnja fotografije...',
    'hu': 'Fénykép beágyazása...',
    'id': 'Menyematkan foto...',
    'it': 'Incorporamento della foto...',
    'ja': '写真を埋め込み中...',
    'ko': '사진 임베딩 중...',
    'lt': 'Įterpiama nuotrauka...',
    'lv': 'Fotoattēla iegulšana...',
    'nl': 'Foto insluiten...',
    'no': 'Bygger inn bilde...',
    'pl': 'Osadzanie zdjęcia...',
    'pt': 'A incorporar foto...',
    'pt-BR': 'Incorporando foto...',
    'ro': 'Se încorporează fotografia...',
    'ru': 'Встраивание фото...',
    'sv': 'Bäddar in foto...',
    'tr': 'Fotoğraf yerleştiriliyor...',
    'uk': 'Вбудовування фото...',
    'zh': '嵌入照片...',
}

TAGLINE = {
    'ar': 'صور موثقة مقاومة للعبث',
    'bg': 'Защитени сертифицирани снимки',
    'cs': 'Fotografie s certifikací odolnou proti manipulaci',
    'da': 'Manipulationssikrede certificerede fotos',
    'de': 'Manipulationssichere zertifizierte Fotos',
    'el': 'Πιστοποιημένες φωτογραφίες με προστασία από παραποίηση',
    'en': 'Tamper-proof certified photos',
    'en-GB': 'Tamper-proof certified photos',
    'es': 'Fotos certificadas a prueba de manipulación',
    'et': 'Võltsimiskindlad sertifitseeritud fotod',
    'fi': 'Peukaloinnilta suojatut sertifioidut valokuvat',
    'fr': 'Photos certifiées inviolables',
    'hi': 'छेड़छाड़-रोधी प्रमाणित फ़ोटो',
    'hr': 'Fotografije certificirane protiv neovlaštenih izmjena',
    'hu': 'Hamisításbiztos tanúsított fotók',
    'id': 'Foto tersertifikasi anti-manipulasi',
    'it': 'Foto certificate a prova di manomissione',
    'ja': '改ざん防止された認証済み写真',
    'ko': '위변조 방지 인증 사진',
    'lt': 'Nuo klastojimo apsaugotos sertifikuotos nuotraukos',
    'lv': 'Pret viltojumiem aizsargātas sertificētas fotogrāfijas',
    'nl': "Manipulatiebestendige gecertificeerde foto's",
    'no': 'Manipulasjonssikre sertifiserte bilder',
    'pl': 'Odporne na manipulacje certyfikowane zdjęcia',
    'pt': 'Fotos certificadas à prova de adulteração',
    'pt-BR': 'Fotos certificadas à prova de adulteração',
    'ro': 'Fotografii certificate rezistente la manipulare',
    'ru': 'Защищённые от подделки сертифицированные фото',
    'sv': 'Manipulationssäkra certifierade foton',
    'tr': 'Kurcalamaya dayanıklı sertifikalı fotoğraflar',
    'uk': 'Захищені від підробки сертифіковані фото',
    'zh': '防篡改认证照片',
}

PRIVATE_PHOTO = {
    'ar': 'صورة خاصة',
    'bg': 'Частна снимка',
    'cs': 'Soukromá fotografie',
    'da': 'Privat foto',
    'de': 'Privates Foto',
    'el': 'Ιδιωτική φωτογραφία',
    'en': 'Private Photo',
    'en-GB': 'Private Photo',
    'es': 'Foto privada',
    'et': 'Privaatne foto',
    'fi': 'Yksityinen valokuva',
    'fr': 'Photo privée',
    'hi': 'निजी फ़ोटो',
    'hr': 'Privatna fotografija',
    'hu': 'Privát fotó',
    'id': 'Foto pribadi',
    'it': 'Foto privata',
    'ja': '非公開の写真',
    'ko': '비공개 사진',
    'lt': 'Privati nuotrauka',
    'lv': 'Privāts fotoattēls',
    'nl': 'Privéfoto',
    'no': 'Privat bilde',
    'pl': 'Prywatne zdjęcie',
    'pt': 'Foto privada',
    'pt-BR': 'Foto privada',
    'ro': 'Fotografie privată',
    'ru': 'Частное фото',
    'sv': 'Privat foto',
    'tr': 'Özel fotoğraf',
    'uk': 'Приватне фото',
    'zh': '私密照片',
}

PUBLIC_PHOTO = {
    'ar': 'صورة عامة',
    'bg': 'Публична снимка',
    'cs': 'Veřejná fotografie',
    'da': 'Offentligt foto',
    'de': 'Öffentliches Foto',
    'el': 'Δημόσια φωτογραφία',
    'en': 'Public Photo',
    'en-GB': 'Public Photo',
    'es': 'Foto pública',
    'et': 'Avalik foto',
    'fi': 'Julkinen valokuva',
    'fr': 'Photo publique',
    'hi': 'सार्वजनिक फ़ोटो',
    'hr': 'Javna fotografija',
    'hu': 'Nyilvános fotó',
    'id': 'Foto publik',
    'it': 'Foto pubblica',
    'ja': '公開写真',
    'ko': '공개 사진',
    'lt': 'Vieša nuotrauka',
    'lv': 'Publisks fotoattēls',
    'nl': 'Openbare foto',
    'no': 'Offentlig bilde',
    'pl': 'Publiczne zdjęcie',
    'pt': 'Foto pública',
    'pt-BR': 'Foto pública',
    'ro': 'Fotografie publică',
    'ru': 'Публичное фото',
    'sv': 'Offentligt foto',
    'tr': 'Herkese açık fotoğraf',
    'uk': 'Публічне фото',
    'zh': '公开照片',
}

PHOTO_ON_DEVICE = {
    'ar': 'الصورة تبقى على جهازك',
    'bg': 'Снимката остава на вашето устройство',
    'cs': 'Fotografie zůstává ve vašem zařízení',
    'da': 'Foto forbliver på din enhed',
    'de': 'Foto bleibt auf Ihrem Gerät',
    'el': 'Η φωτογραφία παραμένει στη συσκευή σας',
    'en': 'Photo stays on your device',
    'en-GB': 'Photo stays on your device',
    'es': 'La foto permanece en su dispositivo',
    'et': 'Foto jääb teie seadmesse',
    'fi': 'Valokuva pysyy laitteellasi',
    'fr': 'La photo reste sur votre appareil',
    'hi': 'फ़ोटो आपके डिवाइस पर ही रहती है',
    'hr': 'Fotografija ostaje na vašem uređaju',
    'hu': 'A fotó az eszközén marad',
    'id': 'Foto tetap ada di perangkat Anda',
    'it': 'La foto rimane sul tuo dispositivo',
    'ja': '写真はデバイスに残ります',
    'ko': '사진은 기기에 그대로 남습니다',
    'lt': 'Nuotrauka lieka jūsų įrenginyje',
    'lv': 'Fotoattēls paliek jūsu ierīcē',
    'nl': 'De foto blijft op je apparaat',
    'no': 'Bildet forblir på enheten din',
    'pl': 'Zdjęcie pozostaje na Twoim urządzeniu',
    'pt': 'A foto permanece no seu dispositivo',
    'pt-BR': 'A foto permanece no seu dispositivo',
    'ro': 'Fotografia rămâne pe dispozitivul dvs.',
    'ru': 'Фото остаётся на вашем устройстве',
    'sv': 'Fotot stannar på din enhet',
    'tr': 'Fotoğraf cihazınızda kalır',
    'uk': 'Фото залишається на вашому пристрої',
    'zh': '照片保留在您的设备上',
}

PHOTO_ON_DEVICE_PROOF = {
    'ar': 'الصورة تبقى على الجهاز، إثبات ملكية',
    'bg': 'Снимката остава на устройството, доказателство за собственост',
    'cs': 'Fotografie zůstává v zařízení, důkaz vlastnictví',
    'da': 'Foto forbliver på enheden, ejerskabsbevis',
    'de': 'Foto bleibt auf dem Gerät, Eigentumsnachweis',
    'el': 'Η φωτογραφία παραμένει στη συσκευή, απόδειξη ιδιοκτησίας',
    'en': 'Photo stays on device, proof of ownership',
    'en-GB': 'Photo stays on device, proof of ownership',
    'es': 'La foto permanece en el dispositivo, prueba de propiedad',
    'et': 'Foto jääb seadmesse, omandi tõend',
    'fi': 'Valokuva pysyy laitteessa, todiste omistuksesta',
    'fr': 'La photo reste sur l’appareil, preuve de propriété',
    'hi': 'फ़ोटो डिवाइस पर रहती है, स्वामित्व का प्रमाण',
    'hr': 'Fotografija ostaje na uređaju, dokaz vlasništva',
    'hu': 'A fotó az eszközön marad, tulajdonjog igazolása',
    'id': 'Foto tetap ada di perangkat, bukti kepemilikan',
    'it': 'La foto rimane sul dispositivo, prova di proprietà',
    'ja': '写真はデバイスに残り、所有証明になります',
    'ko': '사진은 기기에 남고 소유권 증명이 제공됩니다',
    'lt': 'Nuotrauka lieka įrenginyje, nuosavybės įrodymas',
    'lv': 'Fotoattēls paliek ierīcē, īpašumtiesību pierādījums',
    'nl': 'Foto blijft op apparaat, eigendomsbewijs',
    'no': 'Bildet forblir på enheten, eierskapsbevis',
    'pl': 'Zdjęcie pozostaje na urządzeniu, dowód własności',
    'pt': 'A foto permanece no dispositivo, prova de propriedade',
    'pt-BR': 'A foto permanece no dispositivo, prova de propriedade',
    'ro': 'Fotografia rămâne pe dispozitiv, dovadă a proprietății',
    'ru': 'Фото остаётся на устройстве, подтверждение владения',
    'sv': 'Fotot stannar på enheten, ägarbevis',
    'tr': 'Fotoğraf cihazda kalır, sahiplik kanıtı',
    'uk': 'Фото залишається на пристрої, доказ володіння',
    'zh': '照片保留在设备上，所有权证明',
}

PHOTO_QUALITY = {
    'ar': 'جودة الصورة — بدون ضغط، بدون إعادة ترميز',
    'bg': 'Качество на снимката — без компресия, без повторно кодиране',
    'cs': 'Kvalita fotografie — bez komprese, bez překódování',
    'da': 'Fotokvalitet — ingen komprimering, ingen omkodning',
    'de': 'Fotoqualität — keine Komprimierung, keine Neukodierung',
    'el': 'Ποιότητα φωτογραφίας — χωρίς συμπίεση, χωρίς επανακωδικοποίηση',
    'en': 'Photo quality — no compression, no re-encoding',
    'en-GB': 'Photo quality — no compression, no re-encoding',
    'es': 'Calidad de la foto — sin compresión, sin recodificación',
    'et': 'Fotokvaliteet — ilma tihendamiseta, ilma ümberkodeerimiseta',
    'fi': 'Valokuvan laatu — ei pakkausta, ei uudelleenkoodausta',
    'fr': 'Qualité photo — sans compression, sans réencodage',
    'hi': 'फ़ोटो गुणवत्ता — बिना कंप्रेशन, बिना री-एन्कोडिंग',
    'hr': 'Kvaliteta fotografije — bez kompresije, bez ponovnog kodiranja',
    'hu': 'Fotóminőség — tömörítés és újrakódolás nélkül',
    'id': 'Kualitas foto — tanpa kompresi, tanpa pengodean ulang',
    'it': 'Qualità foto — nessuna compressione, nessuna ricodifica',
    'ja': '写真品質 — 圧縮なし、再エンコードなし',
    'ko': '사진 품질 — 압축 없음, 재인코딩 없음',
    'lt': 'Nuotraukos kokybė — be glaudinimo, be perkodavimo',
    'lv': 'Foto kvalitāte — bez saspiešanas, bez pārkodēšanas',
    'nl': 'Fotokwaliteit — geen compressie, geen hercodering',
    'no': 'Fotokvalitet — ingen komprimering, ingen omkoding',
    'pl': 'Jakość zdjęcia — bez kompresji, bez ponownego kodowania',
    'pt': 'Qualidade da foto — sem compressão, sem recodificação',
    'pt-BR': 'Qualidade da foto — sem compressão, sem recodificação',
    'ro': 'Calitate foto — fără compresie, fără recodificare',
    'ru': 'Качество фото — без сжатия, без перекодирования',
    'sv': 'Fotokvalitet — ingen komprimering, ingen omkodning',
    'tr': 'Fotoğraf kalitesi — sıkıştırma yok, yeniden kodlama yok',
    'uk': 'Якість фото — без стиснення, без перекодування',
    'zh': '照片质量 — 无压缩，无重新编码',
}

CERT_DESC = {
    'ar': 'إصدار محدود + مضمّن + مشفّر. يتم تخزين صورتك وبياناتها الوصفية مباشرة داخل سجل الأصالة.',
    'bg': 'Лимитирано издание + Вградено + Шифровано. Вашата снимка и метаданни се съхраняват директно в записа за автентичност.',
    'cs': 'Limitovaná edice + Vložené + Šifrované. Vaše fotografie a metadata jsou uloženy přímo v záznamu pravosti.',
    'da': 'Begrænset udgave + Indlejret + Krypteret. Dit foto og metadata gemmes direkte i ægthedsregistreringen.',
    'de': 'Limitierte Edition + Eingebettet + Verschlüsselt. Ihr Foto und die Metadaten werden direkt im Echtheitsnachweis gespeichert.',
    'el': 'Περιορισμένη έκδοση + Ενσωματωμένο + Κρυπτογραφημένο. Η φωτογραφία και τα μεταδεδομένα σας αποθηκεύονται απευθείας στην εγγραφή αυθεντικότητας.',
    'en': 'Limited Edition + Embedded + Encrypted. Your photo and metadata are stored directly inside the authenticity record.',
    'en-GB': 'Limited Edition + Embedded + Encrypted. Your photo and metadata are stored directly inside the authenticity record.',
    'es': 'Edición limitada + Integrado + Cifrado. Su foto y metadatos se almacenan directamente dentro del registro de autenticidad.',
    'et': 'Piiratud väljaanne + Manustatud + Krüpteeritud. Teie foto ja metaandmed salvestatakse otse autentsuskirjesse.',
    'fi': 'Rajoitettu painos + Upotettu + Salattu. Valokuvasi ja metatiedot tallennetaan suoraan aitoustietueeseen.',
    'fr': 'Édition limitée + Intégré + Chiffré. Votre photo et ses métadonnées sont stockées directement dans le registre d’authenticité.',
    'hi': 'लिमिटेड एडिशन + एम्बेडेड + एन्क्रिप्टेड। आपकी फ़ोटो और मेटाडेटा सीधे प्रामाणिकता रिकॉर्ड के भीतर संग्रहीत होते हैं।',
    'hr': 'Ograničeno izdanje + Ugrađeno + Šifrirano. Vaša fotografija i metapodaci pohranjuju se izravno unutar zapisa autentičnosti.',
    'hu': 'Limitált kiadás + Beágyazott + Titkosított. A fotó és a metaadatok közvetlenül a hitelességi rekordban tárolódnak.',
    'id': 'Edisi Terbatas + Tertanam + Terenkripsi. Foto dan metadata Anda disimpan langsung di dalam catatan keaslian.',
    'it': 'Edizione limitata + Integrato + Crittografato. La tua foto e i metadati sono archiviati direttamente nel record di autenticità.',
    'ja': '限定版 + 埋め込み + 暗号化。写真とメタデータは真正性レコード内に直接保存されます。',
    'ko': '한정판 + 임베드 + 암호화. 사진과 메타데이터는 진위 기록 내부에 직접 저장됩니다.',
    'lt': 'Ribotas leidimas + Įterpta + Užšifruota. Jūsų nuotrauka ir metaduomenys saugomi tiesiogiai autentiškumo įraše.',
    'lv': 'Ierobežota tirāža + Iegults + Šifrēts. Jūsu fotoattēls un metadati tiek glabāti tieši autentiskuma ierakstā.',
    'nl': 'Gelimiteerde editie + Ingesloten + Versleuteld. Je foto en metadata worden rechtstreeks in het authenticiteitsrecord opgeslagen.',
    'no': 'Begrenset utgave + Innebygd + Kryptert. Bildet ditt og metadata lagres direkte i ekthetsdokumentet.',
    'pl': 'Edycja limitowana + Osadzone + Zaszyfrowane. Twoje zdjęcie i metadane są przechowywane bezpośrednio w rejestrze autentyczności.',
    'pt': 'Edição limitada + Incorporada + Encriptada. A sua foto e os metadados são armazenados diretamente no registo de autenticidade.',
    'pt-BR': 'Edição limitada + Incorporada + Criptografada. Sua foto e os metadados são armazenados diretamente no registro de autenticidade.',
    'ro': 'Ediție limitată + Încorporată + Criptată. Fotografia și metadatele dvs. sunt stocate direct în registrul de autenticitate.',
    'ru': 'Ограниченная серия + Встроено + Зашифровано. Ваше фото и метаданные сохраняются прямо в записи подлинности.',
    'sv': 'Begränsad utgåva + Inbäddad + Krypterad. Ditt foto och metadata lagras direkt i äkthetsposten.',
    'tr': 'Sınırlı Sürüm + Gömülü + Şifreli. Fotoğrafınız ve meta veriler doğrudan özgünlük kaydında saklanır.',
    'uk': 'Лімітоване видання + Вбудоване + Зашифроване. Ваше фото та метадані зберігаються безпосередньо в записі автентичності.',
    'zh': '限量版 + 内嵌 + 加密。您的照片和元数据会直接存储在真实性记录中。',
}

LIMITED_EDITION_INFO = {
    'ar': 'الصورة تبقى على جهازك. يتم تسجيل صورة مصغرة وشهادة فقط.',
    'bg': 'Снимката остава на устройството ви. В записа влизат само миниатюра и сертификат.',
    'cs': 'Fotografie zůstává ve vašem zařízení. Do záznamu se ukládá jen náhled a certifikát.',
    'da': 'Foto forbliver på din enhed. Kun et miniaturebillede og certifikat registreres.',
    'de': 'Das Foto bleibt auf Ihrem Gerät. Nur ein Vorschaubild und Zertifikat werden im Datensatz gespeichert.',
    'el': 'Η φωτογραφία παραμένει στη συσκευή σας. Μόνο μια μικρογραφία και ένα πιστοποιητικό καταγράφονται.',
    'en': 'Photo stays on your device. Only a thumbnail and certificate go on record.',
    'en-GB': 'Photo stays on your device. Only a thumbnail and certificate go on record.',
    'es': 'La foto permanece en su dispositivo. Solo una miniatura y un certificado quedan registrados.',
    'et': 'Foto jääb teie seadmesse. Kirjele lisatakse ainult pisipilt ja sertifikaat.',
    'fi': 'Valokuva pysyy laitteellasi. Tietueeseen tallennetaan vain pikkukuva ja sertifikaatti.',
    'fr': 'La photo reste sur votre appareil. Seuls une miniature et un certificat sont enregistrés.',
    'hi': 'फ़ोटो आपके डिवाइस पर ही रहती है। रिकॉर्ड में सिर्फ़ थंबनेल और सर्टिफिकेट जाता है।',
    'hr': 'Fotografija ostaje na vašem uređaju. U zapis idu samo minijatura i certifikat.',
    'hu': 'A fotó az eszközén marad. A rekordba csak egy bélyegkép és tanúsítvány kerül.',
    'id': 'Foto tetap ada di perangkat Anda. Hanya thumbnail dan sertifikat yang masuk ke catatan.',
    'it': 'La foto rimane sul tuo dispositivo. Nel record vengono registrati solo miniatura e certificato.',
    'ja': '写真はデバイスに残ります。記録されるのはサムネイルと証明書のみです。',
    'ko': '사진은 기기에 그대로 남습니다. 기록에는 썸네일과 인증서만 저장됩니다.',
    'lt': 'Nuotrauka lieka jūsų įrenginyje. Į įrašą patenka tik miniatiūra ir sertifikatas.',
    'lv': 'Fotoattēls paliek jūsu ierīcē. Ierakstā nonāk tikai sīktēls un sertifikāts.',
    'nl': 'De foto blijft op je apparaat. Alleen een miniatuur en certificaat worden vastgelegd.',
    'no': 'Bildet forblir på enheten din. Bare et miniatyrbilde og sertifikat registreres.',
    'pl': 'Zdjęcie pozostaje na Twoim urządzeniu. W zapisie trafiają tylko miniatura i certyfikat.',
    'pt': 'A foto permanece no seu dispositivo. Apenas uma miniatura e um certificado entram no registo.',
    'pt-BR': 'A foto permanece no seu dispositivo. Apenas uma miniatura e um certificado entram no registro.',
    'ro': 'Fotografia rămâne pe dispozitivul dvs. În registru intră doar o miniatură și un certificat.',
    'ru': 'Фото остаётся на вашем устройстве. В запись попадают только миниатюра и сертификат.',
    'sv': 'Fotot stannar på din enhet. Endast en miniatyr och ett certifikat registreras.',
    'tr': 'Fotoğraf cihazınızda kalır. Kayda yalnızca bir küçük resim ve sertifika girer.',
    'uk': 'Фото залишається на вашому пристрої. До запису потрапляють лише мініатюра та сертифікат.',
    'zh': '照片保留在您的设备上。只有缩略图和证书会写入记录。',
}

PHOTO_METADATA_INTACT = {
    'ar': 'البيانات الوصفية للصورة سليمة',
    'bg': 'Метаданните на снимката са непокътнати',
    'cs': 'Metadata fotografie jsou neporušená',
    'da': 'Fotometadata er intakte',
    'de': 'Fotometadaten sind intakt',
    'el': 'Τα μεταδεδομένα της φωτογραφίας είναι ανέπαφα',
    'en': 'Photo metadata intact',
    'en-GB': 'Photo metadata intact',
    'es': 'Metadatos de la foto intactos',
    'et': 'Foto metaandmed on terved',
    'fi': 'Valokuvan metatiedot ehjät',
    'fr': 'Métadonnées de la photo intactes',
    'hi': 'फ़ोटो मेटाडेटा अक्षुण्ण',
    'hr': 'Metapodaci fotografije netaknuti',
    'hu': 'A fotó metaadatai sértetlenek',
    'id': 'Metadata foto utuh',
    'it': 'Metadati della foto integri',
    'ja': '写真のメタデータは完全です',
    'ko': '사진 메타데이터 보존',
    'lt': 'Nuotraukos metaduomenys nepažeisti',
    'lv': 'Fotoattēla metadati neskarti',
    'nl': 'Fotometagegevens intact',
    'no': 'Bildemetadata intakte',
    'pl': 'Metadane zdjęcia nienaruszone',
    'pt': 'Metadados da foto intactos',
    'pt-BR': 'Metadados da foto intactos',
    'ro': 'Metadatele fotografiei sunt intacte',
    'ru': 'Метаданные фото не повреждены',
    'sv': 'Fotometadata intakta',
    'tr': 'Fotoğraf meta verileri bozulmamış',
    'uk': 'Метадані фото неушкоджені',
    'zh': '照片元数据完好无损',
}

TRANSFER_TITLE = {
    'ar': 'نقل الصورة',
    'bg': 'Прехвърляне на снимка',
    'cs': 'Převést fotografii',
    'da': 'Overfør foto',
    'de': 'Foto übertragen',
    'el': 'Μεταφορά φωτογραφίας',
    'en': 'Transfer Photo',
    'en-GB': 'Transfer Photo',
    'es': 'Transferir foto',
    'et': 'Teisalda foto',
    'fi': 'Siirrä valokuva',
    'fr': 'Transférer la photo',
    'hi': 'फ़ोटो स्थानांतरित करें',
    'hr': 'Prenesi fotografiju',
    'hu': 'Fotó átvitele',
    'id': 'Transfer Foto',
    'it': 'Trasferisci foto',
    'ja': '写真を転送',
    'ko': '사진 전송',
    'lt': 'Perkelti nuotrauką',
    'lv': 'Pārsūtīt fotoattēlu',
    'nl': 'Foto overdragen',
    'no': 'Overfør bilde',
    'pl': 'Przenieś zdjęcie',
    'pt': 'Transferir foto',
    'pt-BR': 'Transferir foto',
    'ro': 'Transferă fotografia',
    'ru': 'Передать фото',
    'sv': 'Överför foto',
    'tr': 'Fotoğrafı aktar',
    'uk': 'Передати фото',
    'zh': '转移照片',
}

KEY_TRANSLATIONS = {
    'ownPhotosForever': TAGLINE,
    'nftTransferred': NFT_TRANSFERRED,
    'viewInOriginalsAndProofs': VIEW_IN_PHOTOS_AND_PROOFS,
    'embeddingOriginal': EMBEDDING_PHOTO,
    'protectYourOriginals': TAGLINE,
    'blockchainSignedOriginals': TAGLINE,
    'slide3Title': PHOTO_PLURAL,
    'originalOnDevice': PHOTO_ON_DEVICE,
    'copyrightCertificate': PHOTO_ON_DEVICE_PROOF,
    'publicPro2': PHOTO_QUALITY,
    'certDesc': CERT_DESC,
    'limitedEditionInfo': LIMITED_EDITION_INFO,
    'metadataIntact': PHOTO_METADATA_INTACT,
    'privateCertification': PRIVATE_PHOTO,
    'privateCertifiedTitle': PRIVATE_PHOTO,
    'publicCertification': PUBLIC_PHOTO,
    'publicCertifiedOriginal': PUBLIC_PHOTO,
    'publicCertifiedTitle': PUBLIC_PHOTO,
}

PATH_TRANSLATIONS = {
    ('nftTransfer', 'title'): TRANSFER_TITLE,
}

COPY_FROM_PATHS = {
    ('nft', 'mint'): [('nftMint', 'mintNft'), ('nftMint', 'createNft')],
    ('nft', 'mintSuccess'): [('nftMint', 'certifiedSuccessfully'), ('nftMint', 'certifiedSuccess')],
}

ID_WARNING_MESSAGE = 'Transfer Foto bersifat permanen dan tidak dapat dibatalkan. Pastikan Anda memiliki alamat penerima yang benar.'


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--root', type=Path, default=ROOT)
    return parser.parse_args()


def locale_dirs(root: Path) -> list[Path]:
    return [
        root / 'PhotoBackupSystem' / 'solana-seeker' / 'i18n' / 'locales',
        root / 'PhotoBackupSystem' / 'mobile-v2' / 'i18n' / 'locales',
    ]


def get_nested_value(payload: Any, path: tuple[str, ...]) -> Any:
    current = payload
    for key in path:
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def apply_updates(payload: Any, node: Any, locale: str, path: tuple[str, ...] = ()) -> bool:
    changed = False
    if isinstance(node, dict):
        for key in list(node.keys()):
            value = node[key]
            next_path = path + (key,)
            if isinstance(value, (dict, list)):
                if apply_updates(payload, value, locale, next_path):
                    changed = True
                continue
            if not isinstance(value, str):
                continue
            copy_paths = COPY_FROM_PATHS.get(next_path)
            if copy_paths:
                copied = False
                for copy_path in copy_paths:
                    translated = get_nested_value(payload, copy_path)
                    if isinstance(translated, str) and translated and value != translated:
                        node[key] = translated
                        changed = True
                        copied = True
                        break
                if copied:
                    continue
            if next_path in PATH_TRANSLATIONS:
                translated = PATH_TRANSLATIONS[next_path].get(locale)
                if translated and value != translated:
                    node[key] = translated
                    changed = True
                    continue
            translated_map = KEY_TRANSLATIONS.get(key)
            if translated_map:
                translated = translated_map.get(locale)
                if translated and value != translated:
                    node[key] = translated
                    changed = True
                    continue
            if next_path == ('nftTransfer', 'warningMessage') and locale == 'id' and value != ID_WARNING_MESSAGE:
                node[key] = ID_WARNING_MESSAGE
                changed = True
    elif isinstance(node, list):
        for item in node:
            if apply_updates(payload, item, locale, path):
                changed = True
    return changed


def process_locale_file(path: Path, dry_run: bool) -> bool:
    locale = path.stem
    payload = json.loads(path.read_text(encoding='utf-8'))
    changed = apply_updates(payload, payload, locale)
    if changed and not dry_run:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=4) + '\n', encoding='utf-8')
    return changed


def main() -> int:
    args = parse_args()
    changed_files: list[Path] = []
    missing_dirs: list[Path] = []

    for directory in locale_dirs(args.root):
        if not directory.exists():
            missing_dirs.append(directory)
            continue
        for path in sorted(directory.glob('*.json')):
            if process_locale_file(path, args.dry_run):
                changed_files.append(path)

    if missing_dirs:
        for directory in missing_dirs:
            print(f'missing locale dir: {directory}')
        return 1

    mode = 'would update' if args.dry_run else 'updated'
    for path in changed_files:
        print(f'{mode}: {path}')
    print(f'{mode} {len(changed_files)} locale files')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
