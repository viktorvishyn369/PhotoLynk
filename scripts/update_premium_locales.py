from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'PhotoBackupSystem'
MOBILE_LOCALES_DIR = ROOT / 'mobile-v2' / 'i18n' / 'locales'
SOLANA_LOCALES_DIR = ROOT / 'solana-seeker' / 'i18n' / 'locales'
LOCALE_DIRS = [
    MOBILE_LOCALES_DIR,
    SOLANA_LOCALES_DIR,
]

PREMIUM_KEYS = {
    'premiumPerks': '20 GB lifetime storage · 25 free certs · 250 PhotoLynk commission-free certs',
    'premiumActivated': 'Welcome to Premium! 20 GB lifetime encrypted cloud storage activated, 25 completely free certifications and 250 PhotoLynk commission-free certifications included. Full access across all your devices.',
    'perk500': '20 GB lifetime encrypted storage',
    'perkNoFees': '25 completely free + 250 PhotoLynk commission-free certs',
    'perkStorage': '20 GB lifetime encrypted storage',
    'perkFreeCerts': '25 completely free + 250 PhotoLynk commission-free certs',
    'perkCloud': '20 GB lifetime encrypted cloud storage',
    'premiumOnlyMessage': 'Your 20 GB lifetime premium storage remains active. You can still access your account and download data. Uploads stay blocked until your stored data is back within the included premium capacity or you add extra storage.',
    'complimentarySyncMessagePremium': 'You have 3 complimentary days to sync or download data above your included 20 GB premium storage. Your lifetime premium access remains active.',
    'complimentaryExpiredMessagePremium': 'Your complimentary period ended. Your 20 GB lifetime premium storage is still active, and you can continue accessing and downloading your data. Uploads remain blocked until usage is within your included premium capacity or you add extra storage.',
}

ALERT_TRANSLATIONS = {
    'ar': {
        'premiumOnlyMessage': 'تبقى سعة التخزين المميزة مدى الحياة 20 جيجابايت فعّالة. لا يزال بإمكانك الوصول إلى حسابك وتنزيل بياناتك. ستظل عمليات الرفع محظورة حتى يعود حجم بياناتك المخزنة إلى السعة المميزة المضمنة أو تضيف مساحة تخزين إضافية.',
        'complimentarySyncMessagePremium': 'لديك 3 أيام مجانية لمزامنة أو تنزيل البيانات التي تتجاوز سعة التخزين المميزة المضمنة 20 جيجابايت. يظل وصولك المميز مدى الحياة فعّالاً.',
        'complimentaryExpiredMessagePremium': 'انتهت الفترة المجانية. لا تزال سعة التخزين المميزة مدى الحياة 20 جيجابايت فعّالة، ويمكنك الاستمرار في الوصول إلى بياناتك وتنزيلها. ستظل عمليات الرفع محظورة حتى يعود الاستخدام إلى السعة المميزة المضمنة أو تضيف مساحة تخزين إضافية.',
    },
    'bg': {
        'premiumOnlyMessage': 'Вашето доживотно Premium хранилище от 20 GB остава активно. Все още можете да имате достъп до акаунта си и да изтегляте данните си. Качванията остават блокирани, докато съхранените ви данни не се върнат в рамките на включения Premium капацитет или не добавите допълнително място.',
        'complimentarySyncMessagePremium': 'Имате 3 безплатни дни, за да синхронизирате или изтеглите данни над включеното ви Premium хранилище от 20 GB. Вашият доживотен Premium достъп остава активен.',
        'complimentaryExpiredMessagePremium': 'Безплатният ви период приключи. Вашето доживотно Premium хранилище от 20 GB все още е активно и можете да продължите да имате достъп до данните си и да ги изтегляте. Качванията остават блокирани, докато използването ви не се върне в рамките на включения Premium капацитет или не добавите допълнително място.',
    },
    'cs': {
        'premiumOnlyMessage': 'Vaše doživotní Premium úložiště 20 GB zůstává aktivní. Stále máte přístup ke svému účtu a můžete si stahovat svá data. Nahrávání zůstane blokované, dokud se vaše uložená data nevrátí do zahrnuté Premium kapacity nebo nepřidáte další úložiště.',
        'complimentarySyncMessagePremium': 'Máte 3 dny zdarma na synchronizaci nebo stažení dat nad zahrnuté Premium úložiště 20 GB. Váš doživotní Premium přístup zůstává aktivní.',
        'complimentaryExpiredMessagePremium': 'Vaše bezplatné období skončilo. Vaše doživotní Premium úložiště 20 GB je stále aktivní a nadále můžete ke svým datům přistupovat a stahovat je. Nahrávání zůstane blokované, dokud se využití nevrátí do zahrnuté Premium kapacity nebo nepřidáte další úložiště.',
    },
    'da': {
        'premiumOnlyMessage': 'Din livstids Premium-lagring på 20 GB forbliver aktiv. Du kan stadig få adgang til din konto og downloade dine data. Uploads forbliver blokeret, indtil dine lagrede data igen er inden for den inkluderede Premium-kapacitet, eller du tilføjer ekstra lagerplads.',
        'complimentarySyncMessagePremium': 'Du har 3 gratis dage til at synkronisere eller downloade data ud over din inkluderede Premium-lagring på 20 GB. Din livstids Premium-adgang forbliver aktiv.',
        'complimentaryExpiredMessagePremium': 'Din gratis periode er slut. Din livstids Premium-lagring på 20 GB er stadig aktiv, og du kan fortsat få adgang til og downloade dine data. Uploads forbliver blokeret, indtil dit forbrug igen er inden for den inkluderede Premium-kapacitet, eller du tilføjer ekstra lagerplads.',
    },
    'de': {
        'premiumOnlyMessage': 'Ihr lebenslanger 20-GB-Premium-Speicher bleibt aktiv. Sie können weiterhin auf Ihr Konto zugreifen und Ihre Daten herunterladen. Uploads bleiben blockiert, bis Ihre gespeicherten Daten wieder innerhalb des enthaltenen Premium-Kontingents liegen oder Sie zusätzlichen Speicher hinzufügen.',
        'complimentarySyncMessagePremium': 'Sie haben 3 Kulanztage, um Daten oberhalb Ihres enthaltenen 20-GB-Premium-Speichers zu synchronisieren oder herunterzuladen. Ihr lebenslanger Premium-Zugang bleibt aktiv.',
        'complimentaryExpiredMessagePremium': 'Ihre Kulanzfrist ist beendet. Ihr lebenslanger 20-GB-Premium-Speicher ist weiterhin aktiv, und Sie können weiterhin auf Ihre Daten zugreifen und sie herunterladen. Uploads bleiben blockiert, bis Ihre Nutzung wieder innerhalb des enthaltenen Premium-Kontingents liegt oder Sie zusätzlichen Speicher hinzufügen.',
    },
    'el': {
        'premiumOnlyMessage': 'Ο Premium χώρος αποθήκευσης 20 GB εφ’ όρου ζωής παραμένει ενεργός. Μπορείτε ακόμη να έχετε πρόσβαση στον λογαριασμό σας και να κατεβάζετε τα δεδομένα σας. Τα ανεβάσματα παραμένουν μπλοκαρισμένα μέχρι τα αποθηκευμένα δεδομένα σας να επιστρέψουν εντός της περιλαμβανόμενης Premium χωρητικότητας ή να προσθέσετε επιπλέον χώρο.',
        'complimentarySyncMessagePremium': 'Έχετε 3 δωρεάν ημέρες για να συγχρονίσετε ή να κατεβάσετε δεδομένα πάνω από τον περιλαμβανόμενο Premium χώρο 20 GB. Η Premium πρόσβασή σας εφ’ όρου ζωής παραμένει ενεργή.',
        'complimentaryExpiredMessagePremium': 'Η δωρεάν περίοδός σας έληξε. Ο Premium χώρος αποθήκευσης 20 GB εφ’ όρου ζωής εξακολουθεί να είναι ενεργός και μπορείτε να συνεχίσετε να έχετε πρόσβαση και να κατεβάζετε τα δεδομένα σας. Τα ανεβάσματα παραμένουν μπλοκαρισμένα μέχρι η χρήση σας να επιστρέψει εντός της περιλαμβανόμενης Premium χωρητικότητας ή να προσθέσετε επιπλέον χώρο.',
    },
    'es': {
        'premiumOnlyMessage': 'Tu almacenamiento premium vitalicio de 20 GB sigue activo. Aún puedes acceder a tu cuenta y descargar tus datos. Las subidas seguirán bloqueadas hasta que tus datos almacenados vuelvan a estar dentro de la capacidad premium incluida o añadas almacenamiento extra.',
        'complimentarySyncMessagePremium': 'Tienes 3 días gratuitos para sincronizar o descargar los datos que superan tus 20 GB premium incluidos. Tu acceso premium de por vida sigue activo.',
        'complimentaryExpiredMessagePremium': 'Tu período gratuito terminó. Tu almacenamiento premium vitalicio de 20 GB sigue activo y puedes seguir accediendo y descargando tus datos. Las subidas seguirán bloqueadas hasta que tu uso vuelva a estar dentro de la capacidad premium incluida o añadas almacenamiento extra.',
    },
    'et': {
        'premiumOnlyMessage': 'Sinu eluaegne 20 GB Premium-salvestus jääb aktiivseks. Saad endiselt oma kontole juurde pääseda ja oma andmeid alla laadida. Üleslaadimised jäävad blokeerituks, kuni sinu salvestatud andmed on jälle kaasasoleva Premium-mahu piires või lisad täiendavat salvestusruumi.',
        'complimentarySyncMessagePremium': 'Sul on 3 tasuta päeva, et sünkroonida või alla laadida andmeid, mis ületavad sinu kaasasolevat 20 GB Premium-salvestust. Sinu eluaegne Premium-juurdepääs jääb aktiivseks.',
        'complimentaryExpiredMessagePremium': 'Sinu tasuta periood on lõppenud. Sinu eluaegne 20 GB Premium-salvestus on endiselt aktiivne ning saad jätkuvalt oma andmetele ligi ja neid alla laadida. Üleslaadimised jäävad blokeerituks, kuni sinu kasutus on jälle kaasasoleva Premium-mahu piires või lisad täiendavat salvestusruumi.',
    },
    'fi': {
        'premiumOnlyMessage': '20 Gt:n elinikäinen Premium-tallennustilasi pysyy aktiivisena. Voit edelleen käyttää tiliäsi ja ladata tietojasi. Lataukset palveluun pysyvät estettyinä, kunnes tallennetut tietosi ovat jälleen mukana tulevan Premium-kapasiteetin rajoissa tai lisäät lisätallennustilaa.',
        'complimentarySyncMessagePremium': 'Sinulla on 3 ilmaista päivää synkronoida tai ladata tietoja, jotka ylittävät mukana tulevan 20 Gt:n Premium-tallennustilan. Elinikäinen Premium-käyttöoikeutesi pysyy aktiivisena.',
        'complimentaryExpiredMessagePremium': 'Ilmainen jakso on päättynyt. 20 Gt:n elinikäinen Premium-tallennustilasi on edelleen aktiivinen, ja voit edelleen käyttää ja ladata tietojasi. Lataukset palveluun pysyvät estettyinä, kunnes käyttösi palaa mukana tulevan Premium-kapasiteetin rajoihin tai lisäät lisätallennustilaa.',
    },
    'fr': {
        'premiumOnlyMessage': 'Votre stockage Premium à vie de 20 Go reste actif. Vous pouvez toujours accéder à votre compte et télécharger vos données. Les envois restent bloqués jusqu’à ce que vos données stockées reviennent dans la capacité Premium incluse ou que vous ajoutiez du stockage supplémentaire.',
        'complimentarySyncMessagePremium': 'Vous disposez de 3 jours offerts pour synchroniser ou télécharger les données au-dessus de vos 20 Go Premium inclus. Votre accès Premium à vie reste actif.',
        'complimentaryExpiredMessagePremium': 'Votre période offerte est terminée. Votre stockage Premium à vie de 20 Go est toujours actif, et vous pouvez continuer à accéder à vos données et à les télécharger. Les envois restent bloqués jusqu’à ce que votre utilisation revienne dans la capacité Premium incluse ou que vous ajoutiez du stockage supplémentaire.',
    },
    'hi': {
        'premiumOnlyMessage': 'आपका 20 GB आजीवन प्रीमियम स्टोरेज सक्रिय रहता है। आप अभी भी अपने खाते तक पहुँच सकते हैं और अपना डेटा डाउनलोड कर सकते हैं। अपलोड तब तक बंद रहेंगे जब तक आपका संग्रहीत डेटा शामिल प्रीमियम क्षमता के भीतर वापस नहीं आ जाता या आप अतिरिक्त स्टोरेज नहीं जोड़ते।',
        'complimentarySyncMessagePremium': 'आपके पास शामिल 20 GB प्रीमियम स्टोरेज से अधिक डेटा को सिंक या डाउनलोड करने के लिए 3 मानार्थ दिन हैं। आपकी आजीवन प्रीमियम पहुँच सक्रिय रहती है।',
        'complimentaryExpiredMessagePremium': 'आपकी मानार्थ अवधि समाप्त हो गई। आपका 20 GB आजीवन प्रीमियम स्टोरेज अभी भी सक्रिय है, और आप अपने डेटा तक पहुँच और डाउनलोड करना जारी रख सकते हैं। अपलोड तब तक बंद रहेंगे जब तक उपयोग शामिल प्रीमियम क्षमता के भीतर वापस नहीं आ जाता या आप अतिरिक्त स्टोरेज नहीं जोड़ते।',
    },
    'hr': {
        'premiumOnlyMessage': 'Vaša doživotna Premium pohrana od 20 GB ostaje aktivna. I dalje možete pristupiti svom računu i preuzimati svoje podatke. Učitavanja ostaju blokirana dok se vaši pohranjeni podaci ne vrate unutar uključene Premium kvote ili ne dodate dodatnu pohranu.',
        'complimentarySyncMessagePremium': 'Imate 3 besplatna dana za sinkronizaciju ili preuzimanje podataka iznad uključene Premium pohrane od 20 GB. Vaš doživotni Premium pristup ostaje aktivan.',
        'complimentaryExpiredMessagePremium': 'Vaše besplatno razdoblje je završilo. Vaša doživotna Premium pohrana od 20 GB i dalje je aktivna i možete nastaviti pristupati svojim podacima i preuzimati ih. Učitavanja ostaju blokirana dok se korištenje ne vrati unutar uključene Premium kvote ili ne dodate dodatnu pohranu.',
    },
    'hu': {
        'premiumOnlyMessage': 'A 20 GB-os élethosszig tartó Premium tárhelye továbbra is aktív. Továbbra is hozzáférhet a fiókjához és letöltheti az adatait. A feltöltések blokkolva maradnak, amíg a tárolt adatai vissza nem kerülnek a csomagban foglalt Premium kapacitáson belülre, vagy nem ad hozzá extra tárhelyet.',
        'complimentarySyncMessagePremium': '3 ingyenes nap áll rendelkezésére a csomagban foglalt 20 GB Premium tárhely feletti adatok szinkronizálására vagy letöltésére. Az élethosszig tartó Premium-hozzáférése továbbra is aktív marad.',
        'complimentaryExpiredMessagePremium': 'Az ingyenes időszak véget ért. A 20 GB-os élethosszig tartó Premium tárhelye továbbra is aktív, és továbbra is hozzáférhet az adataihoz, illetve letöltheti őket. A feltöltések blokkolva maradnak, amíg a használat vissza nem kerül a csomagban foglalt Premium kapacitáson belülre, vagy nem ad hozzá extra tárhelyet.',
    },
    'id': {
        'premiumOnlyMessage': 'Penyimpanan Premium 20 GB seumur hidup Anda tetap aktif. Anda masih dapat mengakses akun Anda dan mengunduh data Anda. Unggahan akan tetap diblokir sampai data yang Anda simpan kembali berada dalam kapasitas Premium yang disertakan atau Anda menambahkan penyimpanan ekstra.',
        'complimentarySyncMessagePremium': 'Anda memiliki 3 hari gratis untuk menyinkronkan atau mengunduh data di atas penyimpanan Premium 20 GB yang disertakan. Akses Premium seumur hidup Anda tetap aktif.',
        'complimentaryExpiredMessagePremium': 'Periode gratis Anda berakhir. Penyimpanan Premium 20 GB seumur hidup Anda masih aktif, dan Anda tetap dapat mengakses serta mengunduh data Anda. Unggahan tetap diblokir sampai penggunaan Anda kembali berada dalam kapasitas Premium yang disertakan atau Anda menambahkan penyimpanan ekstra.',
    },
    'it': {
        'premiumOnlyMessage': 'Il tuo spazio Premium a vita da 20 GB rimane attivo. Puoi ancora accedere al tuo account e scaricare i tuoi dati. I caricamenti restano bloccati finché i dati archiviati non rientrano di nuovo nella capacità Premium inclusa o non aggiungi spazio extra.',
        'complimentarySyncMessagePremium': 'Hai 3 giorni di cortesia per sincronizzare o scaricare i dati oltre i 20 GB Premium inclusi. Il tuo accesso Premium a vita rimane attivo.',
        'complimentaryExpiredMessagePremium': 'Il tuo periodo di cortesia è terminato. Il tuo spazio Premium a vita da 20 GB è ancora attivo e puoi continuare ad accedere ai tuoi dati e a scaricarli. I caricamenti restano bloccati finché l’utilizzo non rientra nella capacità Premium inclusa o non aggiungi spazio extra.',
    },
    'ja': {
        'premiumOnlyMessage': '20 GB の生涯 Premium ストレージは引き続き有効です。引き続きアカウントにアクセスし、データをダウンロードできます。保存済みデータが付属の Premium 容量内に戻るか、追加ストレージを追加するまで、アップロードはブロックされたままです。',
        'complimentarySyncMessagePremium': '付属の 20 GB Premium ストレージを超えるデータを同期またはダウンロードするための 3 日間の無料期間があります。生涯 Premium アクセスは引き続き有効です。',
        'complimentaryExpiredMessagePremium': '無料期間が終了しました。20 GB の生涯 Premium ストレージは引き続き有効で、引き続きデータにアクセスしてダウンロードできます。使用量が付属の Premium 容量内に戻るか、追加ストレージを追加するまで、アップロードはブロックされたままです。',
    },
    'ko': {
        'premiumOnlyMessage': '20GB 평생 프리미엄 저장공간은 계속 활성 상태입니다. 계속해서 계정에 접근하고 데이터를 다운로드할 수 있습니다. 저장된 데이터 사용량이 포함된 프리미엄 용량 안으로 다시 들어오거나 추가 저장공간을 더할 때까지 업로드는 차단된 상태로 유지됩니다.',
        'complimentarySyncMessagePremium': '포함된 20GB 프리미엄 저장공간을 초과하는 데이터를 동기화하거나 다운로드할 수 있는 3일의 무료 기간이 제공됩니다. 평생 프리미엄 이용 권한은 계속 활성 상태입니다.',
        'complimentaryExpiredMessagePremium': '무료 기간이 종료되었습니다. 20GB 평생 프리미엄 저장공간은 여전히 활성 상태이며, 계속해서 데이터에 접근하고 다운로드할 수 있습니다. 사용량이 포함된 프리미엄 용량 안으로 다시 들어오거나 추가 저장공간을 더할 때까지 업로드는 차단된 상태로 유지됩니다.',
    },
    'lt': {
        'premiumOnlyMessage': 'Jūsų 20 GB viso gyvenimo Premium saugykla lieka aktyvi. Vis dar galite pasiekti savo paskyrą ir atsisiųsti savo duomenis. Įkėlimai liks užblokuoti, kol jūsų saugomi duomenys vėl tilps į įtrauktą Premium talpą arba pridėsite papildomos vietos.',
        'complimentarySyncMessagePremium': 'Turite 3 nemokamas dienas sinchronizuoti arba atsisiųsti duomenis virš įtrauktos 20 GB Premium saugyklos. Jūsų viso gyvenimo Premium prieiga lieka aktyvi.',
        'complimentaryExpiredMessagePremium': 'Jūsų nemokamas laikotarpis baigėsi. Jūsų 20 GB viso gyvenimo Premium saugykla vis dar aktyvi, ir jūs galite toliau pasiekti bei atsisiųsti savo duomenis. Įkėlimai liks užblokuoti, kol naudojimas vėl tilps į įtrauktą Premium talpą arba pridėsite papildomos vietos.',
    },
    'lv': {
        'premiumOnlyMessage': 'Jūsu 20 GB Premium krātuve uz mūžu joprojām ir aktīva. Jūs joprojām varat piekļūt savam kontam un lejupielādēt savus datus. Augšupielādes paliks bloķētas, līdz jūsu saglabātie dati atkal iekļausies iekļautajā Premium ietilpībā vai pievienosiet papildu krātuvi.',
        'complimentarySyncMessagePremium': 'Jums ir 3 bezmaksas dienas, lai sinhronizētu vai lejupielādētu datus virs iekļautās 20 GB Premium krātuves. Jūsu Premium piekļuve uz mūžu joprojām ir aktīva.',
        'complimentaryExpiredMessagePremium': 'Jūsu bezmaksas periods ir beidzies. Jūsu 20 GB Premium krātuve uz mūžu joprojām ir aktīva, un jūs varat turpināt piekļūt saviem datiem un tos lejupielādēt. Augšupielādes paliks bloķētas, līdz lietojums atkal iekļausies iekļautajā Premium ietilpībā vai pievienosiet papildu krātuvi.',
    },
    'nl': {
        'premiumOnlyMessage': 'Je levenslange Premium-opslag van 20 GB blijft actief. Je kunt nog steeds je account openen en je gegevens downloaden. Uploads blijven geblokkeerd totdat je opgeslagen gegevens weer binnen de inbegrepen Premium-capaciteit vallen of je extra opslag toevoegt.',
        'complimentarySyncMessagePremium': 'Je hebt 3 gratis dagen om gegevens boven je inbegrepen Premium-opslag van 20 GB te synchroniseren of te downloaden. Je levenslange Premium-toegang blijft actief.',
        'complimentaryExpiredMessagePremium': 'Je gratis periode is afgelopen. Je levenslange Premium-opslag van 20 GB is nog steeds actief en je kunt je gegevens blijven openen en downloaden. Uploads blijven geblokkeerd totdat je gebruik weer binnen de inbegrepen Premium-capaciteit valt of je extra opslag toevoegt.',
    },
    'no': {
        'premiumOnlyMessage': 'Din livstids Premium-lagring på 20 GB forblir aktiv. Du kan fortsatt få tilgang til kontoen din og laste ned dataene dine. Opplastinger forblir blokkert til de lagrede dataene dine er tilbake innenfor den inkluderte Premium-kapasiteten eller du legger til ekstra lagring.',
        'complimentarySyncMessagePremium': 'Du har 3 gratis dager til å synkronisere eller laste ned data over den inkluderte Premium-lagringen på 20 GB. Din livstids Premium-tilgang forblir aktiv.',
        'complimentaryExpiredMessagePremium': 'Den gratis perioden din er over. Din livstids Premium-lagring på 20 GB er fortsatt aktiv, og du kan fortsatt få tilgang til og laste ned dataene dine. Opplastinger forblir blokkert til bruken din er tilbake innenfor den inkluderte Premium-kapasiteten eller du legger til ekstra lagring.',
    },
    'pl': {
        'premiumOnlyMessage': 'Twoja dożywotnia przestrzeń Premium 20 GB pozostaje aktywna. Nadal możesz uzyskiwać dostęp do swojego konta i pobierać swoje dane. Wysyłanie pozostanie zablokowane, dopóki zapisane dane nie wrócą do limitu wliczonej pojemności Premium lub nie dodasz dodatkowej przestrzeni.',
        'complimentarySyncMessagePremium': 'Masz 3 bezpłatne dni na synchronizację lub pobranie danych ponad wliczoną przestrzeń Premium 20 GB. Twój dożywotni dostęp Premium pozostaje aktywny.',
        'complimentaryExpiredMessagePremium': 'Twój bezpłatny okres dobiegł końca. Twoja dożywotnia przestrzeń Premium 20 GB jest nadal aktywna i nadal możesz uzyskiwać dostęp do swoich danych oraz je pobierać. Wysyłanie pozostanie zablokowane, dopóki wykorzystanie nie wróci do limitu wliczonej pojemności Premium lub nie dodasz dodatkowej przestrzeni.',
    },
    'pt-BR': {
        'premiumOnlyMessage': 'Seu armazenamento Premium vitalício de 20 GB continua ativo. Você ainda pode acessar sua conta e baixar seus dados. Os uploads permanecerão bloqueados até que seus dados armazenados voltem a ficar dentro da capacidade Premium incluída ou você adicione armazenamento extra.',
        'complimentarySyncMessagePremium': 'Você tem 3 dias de cortesia para sincronizar ou baixar dados acima dos 20 GB Premium incluídos. Seu acesso Premium vitalício continua ativo.',
        'complimentaryExpiredMessagePremium': 'Seu período de cortesia terminou. Seu armazenamento Premium vitalício de 20 GB ainda está ativo, e você pode continuar acessando e baixando seus dados. Os uploads permanecerão bloqueados até que o uso volte a ficar dentro da capacidade Premium incluída ou você adicione armazenamento extra.',
    },
    'pt': {
        'premiumOnlyMessage': 'O seu armazenamento Premium vitalício de 20 GB continua ativo. Ainda pode aceder à sua conta e descarregar os seus dados. Os carregamentos permanecerão bloqueados até que os seus dados armazenados voltem a ficar dentro da capacidade Premium incluída ou adicione armazenamento extra.',
        'complimentarySyncMessagePremium': 'Tem 3 dias de cortesia para sincronizar ou descarregar dados acima dos 20 GB Premium incluídos. O seu acesso Premium vitalício continua ativo.',
        'complimentaryExpiredMessagePremium': 'O seu período de cortesia terminou. O seu armazenamento Premium vitalício de 20 GB continua ativo e pode continuar a aceder e a descarregar os seus dados. Os carregamentos permanecerão bloqueados até que a utilização volte a ficar dentro da capacidade Premium incluída ou adicione armazenamento extra.',
    },
    'ro': {
        'premiumOnlyMessage': 'Spațiul tău Premium pe viață de 20 GB rămâne activ. Poți în continuare să îți accesezi contul și să îți descarci datele. Încărcările rămân blocate până când datele stocate revin în capacitatea Premium inclusă sau adaugi spațiu suplimentar.',
        'complimentarySyncMessagePremium': 'Ai 3 zile gratuite pentru a sincroniza sau descărca date peste spațiul Premium inclus de 20 GB. Accesul tău Premium pe viață rămâne activ.',
        'complimentaryExpiredMessagePremium': 'Perioada ta gratuită s-a încheiat. Spațiul tău Premium pe viață de 20 GB este încă activ și poți continua să îți accesezi și să îți descarci datele. Încărcările rămân blocate până când utilizarea revine în capacitatea Premium inclusă sau adaugi spațiu suplimentar.',
    },
    'ru': {
        'premiumOnlyMessage': 'Ваше пожизненное Premium-хранилище на 20 ГБ остаётся активным. Вы по-прежнему можете получать доступ к своей учётной записи и скачивать свои данные. Загрузки останутся заблокированными, пока объём ваших сохранённых данных не вернётся в пределах включённой Premium-ёмкости или пока вы не добавите дополнительное хранилище.',
        'complimentarySyncMessagePremium': 'У вас есть 3 бесплатных дня, чтобы синхронизировать или скачать данные сверх включённого Premium-хранилища на 20 ГБ. Ваш пожизненный Premium-доступ остаётся активным.',
        'complimentaryExpiredMessagePremium': 'Ваш бесплатный период закончился. Ваше пожизненное Premium-хранилище на 20 ГБ всё ещё активно, и вы можете продолжать получать доступ к своим данным и скачивать их. Загрузки останутся заблокированными, пока использование не вернётся в пределы включённой Premium-ёмкости или пока вы не добавите дополнительное хранилище.',
    },
    'sv': {
        'premiumOnlyMessage': 'Ditt livstida Premium-lagringsutrymme på 20 GB förblir aktivt. Du kan fortfarande komma åt ditt konto och ladda ner dina data. Uppladdningar förblir blockerade tills dina lagrade data åter är inom den inkluderade Premium-kapaciteten eller du lägger till extra lagring.',
        'complimentarySyncMessagePremium': 'Du har 3 kostnadsfria dagar för att synkronisera eller ladda ner data över ditt inkluderade Premium-lagringsutrymme på 20 GB. Din livstida Premium-åtkomst förblir aktiv.',
        'complimentaryExpiredMessagePremium': 'Din kostnadsfria period har avslutats. Ditt livstida Premium-lagringsutrymme på 20 GB är fortfarande aktivt och du kan fortsätta att komma åt och ladda ner dina data. Uppladdningar förblir blockerade tills din användning åter är inom den inkluderade Premium-kapaciteten eller du lägger till extra lagring.',
    },
    'tr': {
        'premiumOnlyMessage': '20 GB ömür boyu Premium depolamanız aktif kalır. Hesabınıza erişmeye ve verilerinizi indirmeye devam edebilirsiniz. Yüklemeler, saklanan verileriniz dahil olan Premium kapasite sınırına dönene veya ek depolama ekleyene kadar engelli kalır.',
        'complimentarySyncMessagePremium': 'Dahil olan 20 GB Premium depolamanızın üzerindeki verileri senkronize etmek veya indirmek için 3 ücretsiz gününüz var. Ömür boyu Premium erişiminiz aktif kalır.',
        'complimentaryExpiredMessagePremium': 'Ücretsiz döneminiz sona erdi. 20 GB ömür boyu Premium depolamanız hâlâ aktif ve verilerinize erişmeye ve onları indirmeye devam edebilirsiniz. Kullanımınız dahil olan Premium kapasite sınırına dönene veya ek depolama ekleyene kadar yüklemeler engelli kalır.',
    },
    'uk': {
        'premiumOnlyMessage': 'Ваше довічне Premium-сховище на 20 ГБ залишається активним. Ви й надалі можете отримувати доступ до свого облікового запису та завантажувати свої дані. Завантаження залишатимуться заблокованими, доки обсяг ваших збережених даних знову не повернеться в межі включеної Premium-місткості або доки ви не додасте додаткове сховище.',
        'complimentarySyncMessagePremium': 'У вас є 3 безкоштовні дні, щоб синхронізувати або завантажити дані понад включене Premium-сховище на 20 ГБ. Ваш довічний Premium-доступ залишається активним.',
        'complimentaryExpiredMessagePremium': 'Ваш безкоштовний період завершився. Ваше довічне Premium-сховище на 20 ГБ усе ще активне, і ви можете й надалі отримувати доступ до своїх даних та завантажувати їх. Завантаження залишатимуться заблокованими, доки використання знову не повернеться в межі включеної Premium-місткості або доки ви не додасте додаткове сховище.',
    },
    'zh': {
        'premiumOnlyMessage': '您的 20 GB 终身高级存储仍然有效。您仍然可以访问账户并下载您的数据。在您已存储的数据恢复到包含的高级容量范围内，或您添加额外存储之前，上传将继续被阻止。',
        'complimentarySyncMessagePremium': '您有 3 天免费时间，可同步或下载超出所含 20 GB 高级存储的数据。您的终身高级访问权限仍然有效。',
        'complimentaryExpiredMessagePremium': '您的免费宽限期已结束。您的 20 GB 终身高级存储仍然有效，您仍可继续访问并下载您的数据。在您的使用量恢复到包含的高级容量范围内，或您添加额外存储之前，上传将继续被阻止。',
    },
}

INFO_TRANSLATIONS = {
    'ar': {
        'premiumPerks': '20 جيجابايت مدى الحياة · 25 شهادة مجانية · 250 شهادة PhotoLynk بدون عمولة',
        'premiumActivated': 'مرحبًا بك في Premium! تم تفعيل 20 جيجابايت من التخزين السحابي المشفر مدى الحياة، مع 25 شهادة مجانية بالكامل و250 شهادة PhotoLynk بدون عمولة. وصول كامل على جميع أجهزتك.',
        'perkNoFees': '25 مجانية بالكامل + 250 شهادة PhotoLynk بدون عمولة',
        'perkFreeCerts': '25 مجانية بالكامل + 250 شهادة PhotoLynk بدون عمولة',
    },
    'bg': {
        'premiumPerks': '20 GB доживотно хранилище · 25 безплатни сертификата · 250 сертификата PhotoLynk без комисиона',
        'premiumActivated': 'Добре дошли в Premium! Активирани са 20 GB доживотно криптирано облачно хранилище, 25 напълно безплатни сертификата и 250 сертификата PhotoLynk без комисиона. Пълен достъп на всички ваши устройства.',
        'perkNoFees': '25 напълно безплатни + 250 сертификата PhotoLynk без комисиона',
        'perkFreeCerts': '25 напълно безплатни + 250 сертификата PhotoLynk без комисиона',
    },
    'cs': {
        'premiumPerks': '20 GB doživotního úložiště · 25 certifikací zdarma · 250 certifikací PhotoLynk bez provize',
        'premiumActivated': 'Vítejte v Premium! Aktivováno 20 GB doživotního šifrovaného cloudového úložiště, 25 zcela bezplatných certifikací a 250 certifikací PhotoLynk bez provize. Plný přístup na všech vašich zařízeních.',
        'perkNoFees': '25 zcela zdarma + 250 certifikací PhotoLynk bez provize',
        'perkFreeCerts': '25 zcela zdarma + 250 certifikací PhotoLynk bez provize',
    },
    'da': {
        'premiumPerks': '20 GB livstidslager · 25 gratis certifikater · 250 PhotoLynk provisionsfrie certifikater',
        'premiumActivated': 'Velkommen til Premium! 20 GB livstids krypteret cloud-lagring er aktiveret, inklusive 25 helt gratis certifikater og 250 PhotoLynk provisionsfrie certifikater. Fuld adgang på alle dine enheder.',
        'perkNoFees': '25 helt gratis + 250 PhotoLynk provisionsfrie certifikater',
        'perkFreeCerts': '25 helt gratis + 250 PhotoLynk provisionsfrie certifikater',
    },
    'de': {
        'premiumPerks': '20 GB lebenslanger Speicher · 25 kostenlose Zertifikate · 250 provisionsfreie PhotoLynk-Zertifikate',
        'premiumActivated': 'Willkommen bei Premium! 20 GB lebenslanger verschlüsselter Cloud-Speicher aktiviert, inklusive 25 vollständig kostenloser Zertifikate und 250 provisionsfreier PhotoLynk-Zertifikate. Voller Zugriff auf all Ihren Geräten.',
        'perkNoFees': '25 vollständig kostenlos + 250 provisionsfreie PhotoLynk-Zertifikate',
        'perkFreeCerts': '25 vollständig kostenlos + 250 provisionsfreie PhotoLynk-Zertifikate',
    },
    'el': {
        'premiumPerks': '20 GB εφ’ όρου ζωής · 25 δωρεάν πιστοποιήσεις · 250 πιστοποιήσεις PhotoLynk χωρίς προμήθεια',
        'premiumActivated': 'Καλώς ήρθατε στο Premium! Ενεργοποιήθηκαν 20 GB ισόβιου κρυπτογραφημένου cloud storage, μαζί με 25 εντελώς δωρεάν πιστοποιήσεις και 250 πιστοποιήσεις PhotoLynk χωρίς προμήθεια. Πλήρης πρόσβαση σε όλες τις συσκευές σας.',
        'perkNoFees': '25 εντελώς δωρεάν + 250 πιστοποιήσεις PhotoLynk χωρίς προμήθεια',
        'perkFreeCerts': '25 εντελώς δωρεάν + 250 πιστοποιήσεις PhotoLynk χωρίς προμήθεια',
    },
    'es': {
        'premiumPerks': '20 GB de por vida · 25 certificaciones gratis · 250 certificaciones sin comisión PhotoLynk',
        'premiumActivated': '¡Bienvenido a Premium! Se activaron 20 GB de almacenamiento cifrado de por vida, 25 certificaciones completamente gratuitas y 250 certificaciones sin comisión PhotoLynk. Acceso total en todos tus dispositivos.',
        'perkNoFees': '25 completamente gratis + 250 certificaciones sin comisión PhotoLynk',
        'perkFreeCerts': '25 completamente gratis + 250 certificaciones sin comisión PhotoLynk',
    },
    'et': {
        'premiumPerks': '20 GB eluaegset salvestust · 25 tasuta sertifikaati · 250 PhotoLynk vahendustasuta sertifikaati',
        'premiumActivated': 'Tere tulemast Premiumi! Aktiveeritud on 20 GB eluaegset krüpteeritud pilvesalvestust, 25 täiesti tasuta sertifikaati ja 250 PhotoLynk vahendustasuta sertifikaati. Täielik juurdepääs kõigis sinu seadmetes.',
        'perkNoFees': '25 täiesti tasuta + 250 PhotoLynk vahendustasuta sertifikaati',
        'perkFreeCerts': '25 täiesti tasuta + 250 PhotoLynk vahendustasuta sertifikaati',
    },
    'fi': {
        'premiumPerks': '20 Gt elinikäistä tallennustilaa · 25 ilmaista sertifikaattia · 250 PhotoLynk-sertifikaattia ilman komissiota',
        'premiumActivated': 'Tervetuloa Premiumiin! 20 Gt elinikäistä salattua pilvitallennustilaa aktivoitu, mukana 25 täysin ilmaista sertifikaattia ja 250 PhotoLynk-sertifikaattia ilman komissiota. Täysi käyttö kaikilla laitteillasi.',
        'perkNoFees': '25 täysin ilmaista + 250 PhotoLynk-sertifikaattia ilman komissiota',
        'perkFreeCerts': '25 täysin ilmaista + 250 PhotoLynk-sertifikaattia ilman komissiota',
    },
    'fr': {
        'premiumPerks': '20 Go à vie · 25 certifications offertes · 250 certifications PhotoLynk sans commission',
        'premiumActivated': 'Bienvenue dans Premium ! 20 Go de stockage cloud chiffré à vie activés, avec 25 certifications entièrement offertes et 250 certifications PhotoLynk sans commission incluses. Accès complet sur tous vos appareils.',
        'perkNoFees': '25 entièrement offertes + 250 certifications PhotoLynk sans commission',
        'perkFreeCerts': '25 entièrement offertes + 250 certifications PhotoLynk sans commission',
    },
    'hi': {
        'premiumPerks': '20 GB आजीवन स्टोरेज · 25 मुफ्त प्रमाणपत्र · 250 PhotoLynk बिना-कमीशन प्रमाणपत्र',
        'premiumActivated': 'Premium में आपका स्वागत है! 20 GB आजीवन एन्क्रिप्टेड क्लाउड स्टोरेज सक्रिय हो गया है, साथ में 25 पूरी तरह मुफ्त प्रमाणपत्र और 250 PhotoLynk बिना-कमीशन प्रमाणपत्र शामिल हैं। आपके सभी डिवाइसों पर पूरा एक्सेस।',
        'perkNoFees': '25 पूरी तरह मुफ्त + 250 PhotoLynk बिना-कमीशन प्रमाणपत्र',
        'perkFreeCerts': '25 पूरी तरह मुफ्त + 250 PhotoLynk बिना-कमीशन प्रमाणपत्र',
    },
    'hr': {
        'premiumPerks': '20 GB doživotne pohrane · 25 besplatnih certifikata · 250 PhotoLynk certifikata bez provizije',
        'premiumActivated': 'Dobrodošli u Premium! Aktivirano je 20 GB doživotne šifrirane pohrane u oblaku, uz 25 potpuno besplatnih certifikata i 250 PhotoLynk certifikata bez provizije. Potpuni pristup na svim vašim uređajima.',
        'perkNoFees': '25 potpuno besplatnih + 250 PhotoLynk certifikata bez provizije',
        'perkFreeCerts': '25 potpuno besplatnih + 250 PhotoLynk certifikata bez provizije',
    },
    'hu': {
        'premiumPerks': '20 GB élethosszig tartó tárhely · 25 ingyenes tanúsítvány · 250 PhotoLynk jutalékmentes tanúsítvány',
        'premiumActivated': 'Üdvözli a Premium! Aktiválva: 20 GB élethosszig tartó titkosított felhőtárhely, 25 teljesen ingyenes tanúsítvány és 250 PhotoLynk jutalékmentes tanúsítvány. Teljes hozzáférés minden eszközén.',
        'perkNoFees': '25 teljesen ingyenes + 250 PhotoLynk jutalékmentes tanúsítvány',
        'perkFreeCerts': '25 teljesen ingyenes + 250 PhotoLynk jutalékmentes tanúsítvány',
    },
    'id': {
        'premiumPerks': 'Penyimpanan seumur hidup 20 GB · 25 sertifikasi gratis · 250 sertifikasi PhotoLynk tanpa komisi',
        'premiumActivated': 'Selamat datang di Premium! Penyimpanan cloud terenkripsi seumur hidup 20 GB telah diaktifkan, termasuk 25 sertifikasi sepenuhnya gratis dan 250 sertifikasi PhotoLynk tanpa komisi. Akses penuh di semua perangkat Anda.',
        'perkNoFees': '25 sepenuhnya gratis + 250 sertifikasi PhotoLynk tanpa komisi',
        'perkFreeCerts': '25 sepenuhnya gratis + 250 sertifikasi PhotoLynk tanpa komisi',
    },
    'it': {
        'premiumPerks': '20 GB a vita · 25 certificazioni gratuite · 250 certificazioni PhotoLynk senza commissioni',
        'premiumActivated': 'Benvenuto in Premium! Attivati 20 GB di spazio cloud crittografato a vita, con 25 certificazioni completamente gratuite e 250 certificazioni PhotoLynk senza commissioni incluse. Accesso completo su tutti i tuoi dispositivi.',
        'perkNoFees': '25 completamente gratuite + 250 certificazioni PhotoLynk senza commissioni',
        'perkFreeCerts': '25 completamente gratuite + 250 certificazioni PhotoLynk senza commissioni',
    },
    'ja': {
        'premiumPerks': '20 GB 生涯ストレージ · 25 件の無料証明書 · 250 件の PhotoLynk 手数料無料証明書',
        'premiumActivated': 'Premium へようこそ！20 GB の生涯暗号化クラウドストレージが有効になり、25 件の完全無料証明書と 250 件の PhotoLynk 手数料無料証明書が含まれます。すべてのデバイスでフルアクセスできます。',
        'perkNoFees': '25 件完全無料 + 250 件の PhotoLynk 手数料無料証明書',
        'perkFreeCerts': '25 件完全無料 + 250 件の PhotoLynk 手数料無料証明書',
    },
    'ko': {
        'premiumPerks': '20GB 평생 저장공간 · 무료 인증서 25개 · PhotoLynk 수수료 없는 인증서 250개',
        'premiumActivated': 'Premium에 오신 것을 환영합니다! 20GB 평생 암호화 클라우드 저장공간이 활성화되었으며, 완전 무료 인증서 25개와 PhotoLynk 수수료 없는 인증서 250개가 포함됩니다. 모든 기기에서 전체 이용이 가능합니다.',
        'perkNoFees': '완전 무료 25개 + PhotoLynk 수수료 없는 인증서 250개',
        'perkFreeCerts': '완전 무료 25개 + PhotoLynk 수수료 없는 인증서 250개',
    },
    'lt': {
        'premiumPerks': '20 GB visam laikui · 25 nemokami sertifikatai · 250 PhotoLynk sertifikatų be komisinių',
        'premiumActivated': 'Sveiki atvykę į Premium! Aktyvuota 20 GB visam laikui šifruota debesų saugykla, įskaitant 25 visiškai nemokamus sertifikatus ir 250 PhotoLynk sertifikatų be komisinių. Visiška prieiga visuose jūsų įrenginiuose.',
        'perkNoFees': '25 visiškai nemokami + 250 PhotoLynk sertifikatų be komisinių',
        'perkFreeCerts': '25 visiškai nemokami + 250 PhotoLynk sertifikatų be komisinių',
    },
    'lv': {
        'premiumPerks': '20 GB uz mūžu · 25 bezmaksas sertifikāti · 250 PhotoLynk sertifikāti bez komisijas',
        'premiumActivated': 'Laipni lūdzam Premium! Aktivizēta 20 GB uz mūžu šifrēta mākoņkrātuve, tostarp 25 pilnīgi bezmaksas sertifikāti un 250 PhotoLynk sertifikāti bez komisijas. Pilna piekļuve visās jūsu ierīcēs.',
        'perkNoFees': '25 pilnīgi bezmaksas + 250 PhotoLynk sertifikāti bez komisijas',
        'perkFreeCerts': '25 pilnīgi bezmaksas + 250 PhotoLynk sertifikāti bez komisijas',
    },
    'nl': {
        'premiumPerks': '20 GB levenslange opslag · 25 gratis certificaten · 250 PhotoLynk certificaten zonder commissie',
        'premiumActivated': 'Welkom bij Premium! 20 GB levenslang versleutelde cloudopslag geactiveerd, inclusief 25 volledig gratis certificaten en 250 PhotoLynk certificaten zonder commissie. Volledige toegang op al je apparaten.',
        'perkNoFees': '25 volledig gratis + 250 PhotoLynk certificaten zonder commissie',
        'perkFreeCerts': '25 volledig gratis + 250 PhotoLynk certificaten zonder commissie',
    },
    'no': {
        'premiumPerks': '20 GB livstidslagring · 25 gratis sertifikater · 250 PhotoLynk sertifikater uten provisjon',
        'premiumActivated': 'Velkommen til Premium! 20 GB livstids kryptert skylagring er aktivert, inkludert 25 helt gratis sertifikater og 250 PhotoLynk sertifikater uten provisjon. Full tilgang på alle enhetene dine.',
        'perkNoFees': '25 helt gratis + 250 PhotoLynk sertifikater uten provisjon',
        'perkFreeCerts': '25 helt gratis + 250 PhotoLynk sertifikater uten provisjon',
    },
    'pl': {
        'premiumPerks': '20 GB dożywotniego miejsca · 25 darmowych certyfikatów · 250 certyfikatów PhotoLynk bez prowizji',
        'premiumActivated': 'Witamy w Premium! Aktywowano 20 GB dożywotniej szyfrowanej chmury, w tym 25 całkowicie darmowych certyfikatów i 250 certyfikatów PhotoLynk bez prowizji. Pełny dostęp na wszystkich Twoich urządzeniach.',
        'perkNoFees': '25 całkowicie darmowych + 250 certyfikatów PhotoLynk bez prowizji',
        'perkFreeCerts': '25 całkowicie darmowych + 250 certyfikatów PhotoLynk bez prowizji',
    },
    'pt-BR': {
        'premiumPerks': '20 GB vitalícios · 25 certificações grátis · 250 certificações PhotoLynk sem comissão',
        'premiumActivated': 'Bem-vindo ao Premium! Foram ativados 20 GB de armazenamento em nuvem criptografado vitalício, com 25 certificações totalmente gratuitas e 250 certificações PhotoLynk sem comissão incluídas. Acesso completo em todos os seus dispositivos.',
        'perkNoFees': '25 totalmente grátis + 250 certificações PhotoLynk sem comissão',
        'perkFreeCerts': '25 totalmente grátis + 250 certificações PhotoLynk sem comissão',
    },
    'pt': {
        'premiumPerks': '20 GB vitalícios · 25 certificações grátis · 250 certificações PhotoLynk sem comissão',
        'premiumActivated': 'Bem-vindo ao Premium! Foram ativados 20 GB de armazenamento cloud encriptado vitalício, com 25 certificações totalmente gratuitas e 250 certificações PhotoLynk sem comissão incluídas. Acesso completo em todos os seus dispositivos.',
        'perkNoFees': '25 totalmente grátis + 250 certificações PhotoLynk sem comissão',
        'perkFreeCerts': '25 totalmente grátis + 250 certificações PhotoLynk sem comissão',
    },
    'ro': {
        'premiumPerks': '20 GB pe viață · 25 de certificări gratuite · 250 de certificări PhotoLynk fără comision',
        'premiumActivated': 'Bine ai venit la Premium! Au fost activate 20 GB de stocare cloud criptată pe viață, incluzând 25 de certificări complet gratuite și 250 de certificări PhotoLynk fără comision. Acces complet pe toate dispozitivele tale.',
        'perkNoFees': '25 complet gratuite + 250 de certificări PhotoLynk fără comision',
        'perkFreeCerts': '25 complet gratuite + 250 de certificări PhotoLynk fără comision',
    },
    'ru': {
        'premiumPerks': '20 ГБ пожизненного хранилища · 25 бесплатных сертификатов · 250 сертификатов PhotoLynk без комиссии',
        'premiumActivated': 'Добро пожаловать в Premium! Активировано 20 ГБ пожизненного зашифрованного облачного хранилища, включая 25 полностью бесплатных сертификатов и 250 сертификатов PhotoLynk без комиссии. Полный доступ на всех ваших устройствах.',
        'perkNoFees': '25 полностью бесплатных + 250 сертификатов PhotoLynk без комиссии',
        'perkFreeCerts': '25 полностью бесплатных + 250 сертификатов PhotoLynk без комиссии',
    },
    'sv': {
        'premiumPerks': '20 GB livstidslagring · 25 gratis certifikat · 250 PhotoLynk certifikat utan provision',
        'premiumActivated': 'Välkommen till Premium! 20 GB livstids krypterad molnlagring har aktiverats, inklusive 25 helt gratis certifikat och 250 PhotoLynk certifikat utan provision. Full åtkomst på alla dina enheter.',
        'perkNoFees': '25 helt gratis + 250 PhotoLynk certifikat utan provision',
        'perkFreeCerts': '25 helt gratis + 250 PhotoLynk certifikat utan provision',
    },
    'tr': {
        'premiumPerks': '20 GB ömür boyu depolama · 25 ücretsiz sertifika · 250 PhotoLynk komisyonsuz sertifika',
        'premiumActivated': 'Premium’a hoş geldiniz! 20 GB ömür boyu şifreli bulut depolama etkinleştirildi; buna 25 tamamen ücretsiz sertifika ve 250 PhotoLynk komisyonsuz sertifika dahildir. Tüm cihazlarınızda tam erişim.',
        'perkNoFees': '25 tamamen ücretsiz + 250 PhotoLynk komisyonsuz sertifika',
        'perkFreeCerts': '25 tamamen ücretsiz + 250 PhotoLynk komisyonsuz sertifika',
    },
    'uk': {
        'premiumPerks': '20 ГБ довічного сховища · 25 безкоштовних сертифікатів · 250 сертифікатів PhotoLynk без комісії',
        'premiumActivated': 'Ласкаво просимо до Premium! Активовано 20 ГБ довічного зашифрованого хмарного сховища, включно з 25 повністю безкоштовними сертифікатами та 250 сертифікатами PhotoLynk без комісії. Повний доступ на всіх ваших пристроях.',
        'perkNoFees': '25 повністю безкоштовних + 250 сертифікатів PhotoLynk без комісії',
        'perkFreeCerts': '25 повністю безкоштовних + 250 сертифікатів PhotoLynk без комісії',
    },
    'zh': {
        'premiumPerks': '20 GB 终身存储 · 25 个免费证书 · 250 个 PhotoLynk 免佣金证书',
        'premiumActivated': '欢迎使用 Premium！已激活 20 GB 终身加密云存储，并包含 25 个完全免费的证书和 250 个 PhotoLynk 免佣金证书。您的所有设备都可完整访问。',
        'perkNoFees': '25 个完全免费 + 250 个 PhotoLynk 免佣金证书',
        'perkFreeCerts': '25 个完全免费 + 250 个 PhotoLynk 免佣金证书',
    },
}

ENGLISH_STATUS_KEYS = {
    'premiumOnlyStatus': 'Premium (20 GB lifetime)',
    'subscriptionExpiredGracePremium': 'Your subscription expired, but your 20 GB lifetime premium storage remains active. Download any data above 20 GB during the complimentary period.',
    'subscriptionExpiredPremium': 'Your subscription expired. Your 20 GB lifetime premium storage remains active. Add extra storage anytime if you need more capacity.',
}

SOLANA_INFO_SYNC_KEYS = (
    'addDeposit',
    'depositDesc',
    'creditBalance',
    'premiumUpgrade',
    'premiumActive',
    'premiumPerks',
    'goPremium',
    'oneTime',
    'confirmPurchaseTitle',
    'confirmDepositBody',
    'confirmPremiumBody',
    'byPurchasingAgree',
    'packageFootnote',
    'premiumActivated',
    'addedToBalance',
    'paymentReceivedCreditFailed',
    'paymentReceivedPremiumFailed',
    'certifiedImages',
    'perk500',
    'perkNoFees',
    'perkStorage',
    'perkFreeCerts',
    'perkCloud',
    'perkDevices',
)

SOLANA_NFT_MINT_SYNC_KEYS = (
    'createNft',
    'selectPhotoForNft',
    'next',
    'nftName',
    'enterNftName',
    'descriptionOptional',
    'enterDescription',
    'imageStorage',
    'proofId',
    'cost',
    'remaining',
    'photoName',
    'selectPhoto',
    'removePrivateDataDesc',
    'exifPreservedPrivate',
    'freeRemaining',
    'noAppFee',
)

SOLANA_STATUS_SYNC_KEYS = (
    'processing',
)

SOLANA_INFO_EXTRA_TRANSLATIONS = {
    'cs': {
        'premiumUpgrade': 'Přechod na Premium',
    },
    'fr': {
        'premiumUpgrade': 'Passer en Premium',
        'perkSolana': 'Payer en SOL via portefeuille matériel',
        'processing': 'Traitement...',
    },
    'nl': {
        'premiumUpgrade': 'Premium-upgrade',
    },
}

SOLANA_INFO_EXTRA_KEYS = tuple(dict.fromkeys(
    key
    for translations in SOLANA_INFO_EXTRA_TRANSLATIONS.values()
    for key in translations
))

PURCHASE_BODY_TRANSLATIONS = {
    'cs': {
        'confirmDepositBody': 'Chystáte se zakoupit kredit za 15 $. Pokračováním souhlasíte s podmínkami použití a zásadami ochrany osobních údajů.',
        'confirmPremiumBody': 'Chystáte se zakoupit Premium za 49,99 $ (jednorázově). Pokračováním souhlasíte s podmínkami použití a zásadami ochrany osobních údajů.',
    },
    'da': {
        'confirmDepositBody': 'Du er ved at købe kredit for 15 $. Ved at fortsætte accepterer du vilkårene for brug og privatlivspolitikken.',
        'confirmPremiumBody': 'Du er ved at købe Premium for 49,99 $ (engangsbetaling). Ved at fortsætte accepterer du vilkårene for brug og privatlivspolitikken.',
    },
    'el': {
        'confirmDepositBody': 'Πρόκειται να αγοράσετε πίστωση 15 $. Συνεχίζοντας, αποδέχεστε τους Όρους Χρήσης και την Πολιτική Απορρήτου.',
        'confirmPremiumBody': 'Πρόκειται να αγοράσετε το Premium για 49,99 $ (εφάπαξ). Συνεχίζοντας, αποδέχεστε τους Όρους Χρήσης και την Πολιτική Απορρήτου.',
    },
    'en-GB': {
        'confirmDepositBody': 'You are about to purchase £15 credit. By continuing, you agree to the Terms of Use and Privacy Policy.',
        'confirmPremiumBody': 'You are about to purchase Premium for £49.99 (one-off). By continuing, you agree to the Terms of Use and Privacy Policy.',
    },
    'et': {
        'confirmDepositBody': 'Olete ostmas 15 $ krediiti. Jätkates nõustute kasutustingimuste ja privaatsuspoliitikaga.',
        'confirmPremiumBody': 'Olete ostmas Premiumit hinnaga 49,99 $ (ühekordne makse). Jätkates nõustute kasutustingimuste ja privaatsuspoliitikaga.',
    },
    'fi': {
        'confirmDepositBody': 'Olet ostamassa 15 $ krediittiä. Jatkamalla hyväksyt käyttöehdot ja tietosuojakäytännön.',
        'confirmPremiumBody': 'Olet ostamassa Premiumin hintaan 49,99 $ (kertamaksu). Jatkamalla hyväksyt käyttöehdot ja tietosuojakäytännön.',
    },
    'hi': {
        'confirmDepositBody': 'आप $15 क्रेडिट खरीदने वाले हैं। जारी रखकर, आप उपयोग की शर्तों और गोपनीयता नीति से सहमत होते हैं।',
        'confirmPremiumBody': 'आप $49.99 में Premium खरीदने वाले हैं (एक बार). जारी रखकर, आप उपयोग की शर्तों और गोपनीयता नीति से सहमत होते हैं।',
    },
    'hr': {
        'confirmDepositBody': 'Upravo ćete kupiti kredit od 15 $. Nastavkom prihvaćate Uvjete korištenja i Pravila privatnosti.',
        'confirmPremiumBody': 'Upravo ćete kupiti Premium za 49,99 $ (jednokratno). Nastavkom prihvaćate Uvjete korištenja i Pravila privatnosti.',
    },
    'hu': {
        'confirmDepositBody': 'Ön 15 $ kredit vásárlására készül. A folytatással elfogadja a Felhasználási feltételeket és az Adatvédelmi irányelveket.',
        'confirmPremiumBody': 'Ön a Premium megvásárlására készül 49,99 $-ért (egyszeri fizetés). A folytatással elfogadja a Felhasználási feltételeket és az Adatvédelmi irányelveket.',
    },
    'id': {
        'confirmDepositBody': 'Anda akan membeli kredit $15. Dengan melanjutkan, Anda menyetujui Ketentuan Penggunaan dan Kebijakan Privasi.',
        'confirmPremiumBody': 'Anda akan membeli Premium seharga $49.99 (sekali bayar). Dengan melanjutkan, Anda menyetujui Ketentuan Penggunaan dan Kebijakan Privasi.',
    },
    'lt': {
        'confirmDepositBody': 'Ketinate įsigyti 15 $ kreditą. Tęsdami sutinkate su naudojimo sąlygomis ir privatumo politika.',
        'confirmPremiumBody': 'Ketinate įsigyti Premium už 49,99 $ (vienkartinis mokėjimas). Tęsdami sutinkate su naudojimo sąlygomis ir privatumo politika.',
    },
    'lv': {
        'confirmDepositBody': 'Jūs gatavojaties iegādāties 15 $ kredītu. Turpinot, jūs piekrītat Lietošanas noteikumiem un Privātuma politikai.',
        'confirmPremiumBody': 'Jūs gatavojaties iegādāties Premium par 49,99 $ (vienreizējs maksājums). Turpinot, jūs piekrītat Lietošanas noteikumiem un Privātuma politikai.',
    },
    'nl': {
        'confirmDepositBody': 'U staat op het punt $15 tegoed te kopen. Door verder te gaan, gaat u akkoord met de gebruiksvoorwaarden en het privacybeleid.',
        'confirmPremiumBody': 'U staat op het punt Premium te kopen voor $49.99 (eenmalig). Door verder te gaan, gaat u akkoord met de gebruiksvoorwaarden en het privacybeleid.',
    },
    'no': {
        'confirmDepositBody': 'Du er i ferd med å kjøpe $15 i kreditt. Ved å fortsette godtar du bruksvilkårene og personvernerklæringen.',
        'confirmPremiumBody': 'Du er i ferd med å kjøpe Premium for $49.99 (engangsbetaling). Ved å fortsette godtar du bruksvilkårene og personvernerklæringen.',
    },
    'pl': {
        'confirmDepositBody': 'Za chwilę kupisz kredyt za 15 $. Kontynuując, akceptujesz Warunki korzystania i Politykę prywatności.',
        'confirmPremiumBody': 'Za chwilę kupisz Premium za 49,99 $ (jednorazowo). Kontynuując, akceptujesz Warunki korzystania i Politykę prywatności.',
    },
    'ro': {
        'confirmDepositBody': 'Urmează să achiziționezi credit de 15 $. Continuând, ești de acord cu Termenii de utilizare și Politica de confidențialitate.',
        'confirmPremiumBody': 'Urmează să achiziționezi Premium pentru 49,99 $ (o singură plată). Continuând, ești de acord cu Termenii de utilizare și Politica de confidențialitate.',
    },
    'sv': {
        'confirmDepositBody': 'Du är på väg att köpa kredit för $15. Genom att fortsätta godkänner du användarvillkoren och integritetspolicyn.',
        'confirmPremiumBody': 'Du är på väg att köpa Premium för $49.99 (engångsbetalning). Genom att fortsätta godkänner du användarvillkoren och integritetspolicyn.',
    },
    'tr': {
        'confirmDepositBody': '$15 kredi satın almak üzeresiniz. Devam ederek Kullanım Koşulları ve Gizlilik Politikasını kabul etmiş olursunuz.',
        'confirmPremiumBody': 'Premium\'u $49.99 karşılığında satın almak üzeresiniz (tek seferlik). Devam ederek Kullanım Koşulları ve Gizlilik Politikasını kabul etmiş olursunuz.',
    },
    'uk': {
        'confirmDepositBody': 'Ви збираєтеся придбати кредит на $15. Продовжуючи, ви погоджуєтеся з Умовами використання та Політикою конфіденційності.',
        'confirmPremiumBody': 'Ви збираєтеся придбати Premium за $49.99 (одноразово). Продовжуючи, ви погоджуєтеся з Умовами використання та Політикою конфіденційності.',
    },
}

PURCHASE_BODY_KEYS = tuple(dict.fromkeys(
    key
    for translations in PURCHASE_BODY_TRANSLATIONS.values()
    for key in translations
))

EXACT_REPLACEMENTS = [
    (
        '100 GB encrypted cloud storage activated, 25 free certifications and 250 commission-free certifications included. Full access across all your devices.',
        PREMIUM_KEYS['premiumActivated'].split('Welcome to Premium! ', 1)[1],
    ),
    (
        'Welcome to Premium! 100 GB encrypted cloud storage activated, 25 free certifications and 250 commission-free certifications included. Full access across all your devices.',
        PREMIUM_KEYS['premiumActivated'],
    ),
    ('100 GB encrypted storage — 4 years', '20 GB lifetime encrypted storage'),
    ('100 GB encrypted storage — permanent', '20 GB lifetime encrypted storage'),
    ('100 GB encrypted cloud storage — 4 years', '20 GB lifetime encrypted cloud storage'),
    ('100 GB permanent encrypted cloud storage', '20 GB lifetime encrypted cloud storage'),
    ('100 GB cloud · 250 commission-free certs', PREMIUM_KEYS['premiumPerks']),
    ('25 free + 250 commission-free certs', '25 completely free + 250 PhotoLynk commission-free certs'),
    (
        'Your 100 GB premium storage is active permanently. Download any data beyond 100 GB or renew your plan for more space. If you need more time, contact support.',
        PREMIUM_KEYS['premiumOnlyMessage'],
    ),
    (
        'Your 100 GB premium storage is active. Download any data beyond 100 GB or renew your plan for more space. If you need more time, contact support.',
        PREMIUM_KEYS['premiumOnlyMessage'],
    ),
    (
        'You have 3 complimentary days to sync/download additional data. Your 100 GB premium storage remains active permanently.',
        PREMIUM_KEYS['complimentarySyncMessagePremium'],
    ),
    (
        'You have 3 complimentary days to sync/download additional data. Your 100 GB premium storage remains active.',
        PREMIUM_KEYS['complimentarySyncMessagePremium'],
    ),
    (
        'Your complimentary period ended. Your 100 GB premium storage is still active. Choose a plan for additional storage.',
        PREMIUM_KEYS['complimentaryExpiredMessagePremium'],
    ),
    ('Premium (100 GB permanent)', ENGLISH_STATUS_KEYS['premiumOnlyStatus']),
    ('Premium (100 GB — 4 years)', ENGLISH_STATUS_KEYS['premiumOnlyStatus']),
    (
        'Your subscription expired but your permanent 100 GB premium storage is still active. Download any data beyond 100 GB within 7 days.',
        ENGLISH_STATUS_KEYS['subscriptionExpiredGracePremium'],
    ),
    (
        'Your subscription expired but your 100 GB premium storage is still active. Download any data beyond 100 GB within 7 days.',
        ENGLISH_STATUS_KEYS['subscriptionExpiredGracePremium'],
    ),
    (
        'Your subscription expired. Your 100 GB premium storage remains active permanently. Renew a plan for additional storage.',
        ENGLISH_STATUS_KEYS['subscriptionExpiredPremium'],
    ),
    (
        'Your subscription expired. Your 100 GB premium storage remains active. Renew a plan for additional storage.',
        ENGLISH_STATUS_KEYS['subscriptionExpiredPremium'],
    ),
]

LIFETIME_REPLACEMENTS = [
    ('100 GB', '20 GB'),
    ('100GB', '20GB'),
    ('100 Go', '20 Go'),
    ('100 Gt', '20 Gt'),
    ('100 ГБ', '20 ГБ'),
    ('100 جيجابايت', '20 جيجابايت'),
    ('4 years', 'lifetime'),
    ('4 year', 'lifetime'),
    ('4 سنوات', 'مدى الحياة'),
    ('4 años', 'de por vida'),
    ('4 ans', 'à vie'),
    ('4 Jahre', 'lebenslang'),
    ('4 år', 'livstid'),
    ('4 tahun', 'seumur hidup'),
    ('4 anni', 'a vita'),
    ('4 години', 'доживотно'),
    ('4 χρόνια', 'ισόβια'),
    ('4 года', 'пожизненно'),
    ('4 роки', 'довічно'),
    ('4 yıl', 'ömür boyu'),
    ('4 vuotta', 'elinikäinen'),
    ('4 metai', 'visam laikui'),
    ('4 gadi', 'uz mūžu'),
    ('4 lata', 'dożywotnio'),
    ('4 év', 'élethosszig'),
    ('4 godine', 'doživotno'),
    ('4 roky', 'doživotně'),
    ('4 aastat', 'eluaegne'),
    ('4 anos', 'vitalício'),
    ('4 साल', 'आजीवन'),
    ('4年間', '生涯'),
    ('4년', '평생'),
    ('4 年', '终身'),
    ('4年', '终身'),
    ('25 free + 250 commission-free certs', '25 completely free + 250 PhotoLynk commission-free certs'),
    ('100 GB cloud · 250 commission-free certs', PREMIUM_KEYS['premiumPerks']),
]

TARGET_KEYS = (
    tuple(PREMIUM_KEYS)
    + tuple(ENGLISH_STATUS_KEYS)
    + SOLANA_INFO_SYNC_KEYS
    + SOLANA_INFO_EXTRA_KEYS
    + SOLANA_NFT_MINT_SYNC_KEYS
    + PURCHASE_BODY_KEYS
)
KEY_PATTERNS = {
    key: re.compile(rf'("{re.escape(key)}"\s*:\s*")(.*?)(")')
    for key in TARGET_KEYS
}


def _apply_lifetime_replacements(value: str) -> str:
    for old, new in LIFETIME_REPLACEMENTS:
        value = value.replace(old, new)
    return value


def _replace_key_value(text: str, key: str, replacement: str) -> str:
    pattern = KEY_PATTERNS[key]
    escaped = json.dumps(replacement, ensure_ascii=False)[1:-1]
    return pattern.sub(lambda m: f'{m.group(1)}{escaped}{m.group(3)}', text)


def _replace_key_value_with_transform(text: str, key: str) -> str:
    pattern = KEY_PATTERNS[key]

    def repl(match: re.Match[str]) -> str:
        value = _apply_lifetime_replacements(match.group(2))
        return f'{match.group(1)}{value}{match.group(3)}'

    return pattern.sub(repl, text)


def _upsert_section_keys(text: str, section_key: str, replacements: dict[str, str]) -> str:
    section_pattern = re.compile(rf'("{re.escape(section_key)}"\s*:\s*\{{)(.*?)(\n\s*\}}[,])', re.S)
    match = section_pattern.search(text)
    if not match:
        return text
    body = match.group(2)
    for key, value in replacements.items():
        escaped = json.dumps(value, ensure_ascii=False)[1:-1]
        key_pattern = re.compile(rf'(\n\s*"{re.escape(key)}"\s*:\s*")(.*?)(")')
        if key_pattern.search(body):
            body = key_pattern.sub(lambda m: f'{m.group(1)}{escaped}{m.group(3)}', body)
            continue
        stripped = body.rstrip()
        if stripped and not stripped.endswith(','):
            stripped = f'{stripped},'
        if stripped:
            stripped = f'{stripped}\n        "{key}": "{escaped}"'
        else:
            stripped = f'\n        "{key}": "{escaped}"'
        body = stripped
    return f'{text[:match.start()]}{match.group(1)}{body}{match.group(3)}{text[match.end():]}'


def _get_nested_value(data: dict, path: tuple[str, ...]) -> str | None:
    value = data
    for key in path:
        if not isinstance(value, dict) or key not in value:
            return None
        value = value[key]
    return value if isinstance(value, str) else None


def _should_sync_section_value(
    target_data: dict,
    english_data: dict,
    section_key: str,
    key: str,
    source_value: str,
) -> bool:
    current_value = _get_nested_value(target_data, (section_key, key))
    if current_value is None:
        return True
    english_value = _get_nested_value(english_data, (section_key, key))
    return english_value is not None and current_value == english_value and source_value != english_value


def _sync_solana_locale_from_mobile(text: str, locale_id: str) -> str:
    source_path = MOBILE_LOCALES_DIR / f'{locale_id}.json'
    if not source_path.exists():
        return text
    target_data = json.loads(text)
    source_data = json.loads(source_path.read_text(encoding='utf-8'))
    english_data = json.loads((SOLANA_LOCALES_DIR / 'en.json').read_text(encoding='utf-8'))

    info_values: dict[str, str] = {}
    for key in SOLANA_INFO_SYNC_KEYS:
        source_value = _get_nested_value(source_data, ('info', key))
        if source_value is not None and _should_sync_section_value(target_data, english_data, 'info', key, source_value):
            info_values[key] = source_value
    if locale_id in SOLANA_INFO_EXTRA_TRANSLATIONS:
        for key, value in SOLANA_INFO_EXTRA_TRANSLATIONS[locale_id].items():
            if _should_sync_section_value(target_data, english_data, 'info', key, value):
                info_values[key] = value
    if info_values:
        text = _upsert_section_keys(text, 'info', info_values)

    target_nft_mint = target_data.get('nftMint') if isinstance(target_data.get('nftMint'), dict) else {}
    source_nft_mint = source_data.get('nftMint') if isinstance(source_data.get('nftMint'), dict) else {}
    nft_mint_values: dict[str, str] = {}
    for key, source_value in source_nft_mint.items():
        if not isinstance(source_value, str):
            continue
        if key not in target_nft_mint and key not in SOLANA_NFT_MINT_SYNC_KEYS:
            continue
        if _should_sync_section_value(target_data, english_data, 'nftMint', key, source_value):
            nft_mint_values[key] = source_value
    if nft_mint_values:
        text = _upsert_section_keys(text, 'nftMint', nft_mint_values)

    status_values: dict[str, str] = {}
    for key in SOLANA_STATUS_SYNC_KEYS:
        source_value = _get_nested_value(source_data, ('status', key))
        if source_value is not None and _should_sync_section_value(target_data, english_data, 'status', key, source_value):
            status_values[key] = source_value
    if status_values:
        text = _upsert_section_keys(text, 'status', status_values)
    return text


def update_file(path: Path) -> bool:
    text = path.read_text(encoding='utf-8')
    original = text
    locale_id = path.stem

    for old, new in EXACT_REPLACEMENTS:
        text = text.replace(old, new)

    if path.name in {'en.json', 'en-GB.json'}:
        for key, value in PREMIUM_KEYS.items():
            text = _replace_key_value(text, key, value)
        for key, value in ENGLISH_STATUS_KEYS.items():
            text = _replace_key_value(text, key, value)
    else:
        for key in PREMIUM_KEYS:
            text = _replace_key_value_with_transform(text, key)
        for key in ENGLISH_STATUS_KEYS:
            text = _replace_key_value_with_transform(text, key)
        if locale_id in ALERT_TRANSLATIONS:
            for key, value in ALERT_TRANSLATIONS[locale_id].items():
                text = _replace_key_value(text, key, value)
        if locale_id in INFO_TRANSLATIONS:
            for key, value in INFO_TRANSLATIONS[locale_id].items():
                text = _replace_key_value(text, key, value)
    if path.parent.name == 'locales' and 'solana-seeker' in str(path):
        text = _sync_solana_locale_from_mobile(text, locale_id)
    if locale_id in PURCHASE_BODY_TRANSLATIONS:
        text = _upsert_section_keys(text, 'info', PURCHASE_BODY_TRANSLATIONS[locale_id])

    if text != original:
        path.write_text(text, encoding='utf-8')
        return True
    return False


def main() -> int:
    updated: list[str] = []
    for locale_dir in LOCALE_DIRS:
        for path in sorted(locale_dir.glob('*.json')):
            if update_file(path):
                updated.append(str(path.relative_to(ROOT.parent)))

    for item in updated:
        print(item)
    print(f'UPDATED={len(updated)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
