#!/usr/bin/env python3
import json
import os
from pathlib import Path

# Pairing terminology fixes for specific languages
# Format: locale_code: {key: corrected_value}
PAIRING_FIXES = {
    'ru': {
        'headerTitle': 'Связать телефон / планшет',
        'title': 'Связать другой телефон или планшет',
        'subtitle': 'Поделитесь аккаунтом между телефонами и планшетами. Для связи с сервером на ПК используйте Настройки.',
        'showQrTitle': 'QR-код для связи',
        'showQrInstruction': 'Откройте другое приложение PhotoLynk/Solana Seeker, нажмите значок связи и отсканируйте этот QR-код.',
        'scanTitle': 'Сканировать QR-код',
        'scanInstruction': 'Наведите камеру на QR-код, показанный на другом устройстве.',
        'linking': 'Связывание устройств...',
        'linkFailed': 'Не удалось связать устройства.',
        'unlinkFailed': 'Не удалось отключить устройство',
        'linkedDevices': 'Связанные устройства',
        'storePairedCredentials': 'Сохранить данные связанного устройства',
        'switchAccountPrompt': 'Подтвердите для переключения аккаунтов',
        'credentialsNotFound': 'Данные связанного устройства не найдены',
        'bioPromptShowQr': 'Подтвердите для показа QR-кода',
        'sharedOnOtherDevice': 'Общий доступ на другом устройстве'
    },
    'uk': {
        'headerTitle': "Зв'язати телефон / планшет",
        'title': "Зв'язати інший телефон або планшет",
        'subtitle': "Діліться обліковим записом між телефонами та планшетами. Для зв'язку з сервером на ПК використовуйте Налаштування.",
        'showQrInstruction': "Відкрийте іншу програму PhotoLynk/Solana Seeker, натисніть значок зв'язку та відскануйте цей QR-код.",
        'scanTitle': 'Сканувати QR-код',
        'scanInstruction': 'Наведіть камеру на QR-код, показаний на іншому пристрої',
        'storePairedCredentials': "Зберегти дані зв'язаного пристрою",
        'switchAccountPrompt': 'Підтвердіть для переключення облікових записів',
        'credentialsNotFound': "Дані зв'язаного пристрою не знайдено",
        'bioPromptShowQr': 'Підтвердіть для показу QR-коду',
    },
    'pl': {
        'showQrInstruction': 'Otwórz inną aplikację PhotoLynk/Solana Seeker, dotknij ikony łączenia i zeskanuj ten kod QR.',
        'scanTitle': 'Skanuj kod QR',
        'bioPromptShowQr': 'Uwierzytelnij się, aby pokazać kod QR',
    },
    'de': {
        'showQrInstruction': 'Öffnen Sie die andere PhotoLynk/Solana Seeker-App, tippen Sie auf das Verknüpfungssymbol und scannen Sie diesen QR-Code.',
        'scanInstruction': 'Richten Sie die Kamera auf den QR-Code auf dem anderen Gerät',
    },
    'fr': {
        'showQrInstruction': "Ouvrez l'autre application PhotoLynk/Solana Seeker, appuyez sur l'icône de liaison et scannez ce code QR.",
        'scanInstruction': "Pointez l'appareil photo vers le code QR affiché sur l'autre appareil",
    },
    'es': {
        'showQrInstruction': 'Abre la otra aplicación PhotoLynk/Solana Seeker, toca el icono de vinculación y escanea este código QR.',
        'scanInstruction': 'Apunta la cámara al código QR mostrado en el otro dispositivo',
    },
    'it': {
        'showQrInstruction': "Apri l'altra app PhotoLynk/Solana Seeker, tocca l'icona di collegamento e scansiona questo codice QR.",
        'scanInstruction': "Punta la fotocamera sul codice QR mostrato sull'altro dispositivo",
    },
    'pt': {
        'showQrInstruction': 'Abra o outro aplicativo PhotoLynk/Solana Seeker, toque no ícone de vinculação e escaneie este código QR.',
        'scanInstruction': 'Aponte a câmera para o código QR exibido no outro dispositivo',
    },
    'ja': {
        'showQrInstruction': '他のPhotoLynk/Solana Seekerアプリを開き、リンクアイコンをタップして、このQRコードをスキャンしてください。',
        'scanInstruction': '他のデバイスに表示されているQRコードにカメラを向けてください',
    },
    'ko': {
        'showQrInstruction': '다른 PhotoLynk/Solana Seeker 앱을 열고 연결 아이콘을 탭한 후 이 QR 코드를 스캔하세요.',
        'scanInstruction': '다른 기기에 표시된 QR 코드에 카메라를 향하세요',
    },
    'zh': {
        'showQrInstruction': '打开另一个PhotoLynk/Solana Seeker应用，点击链接图标并扫描此二维码。',
        'scanInstruction': '将相机对准另一台设备上显示的二维码',
    },
    'zh-TW': {
        'showQrInstruction': '開啟另一個PhotoLynk/Solana Seeker應用程式，點擊連結圖示並掃描此QR碼。',
        'scanInstruction': '將相機對準另一台裝置上顯示的QR碼',
    },
    'ar': {
        'scanInstruction': 'وجه الكاميرا نحو رمز QR المعروض على الجهاز الآخر',
    },
    'tr': {
        'showQrInstruction': 'Diğer PhotoLynk/Solana Seeker uygulamasını açın, bağlantı simgesine dokunun ve bu QR kodunu tarayın.',
        'scanInstruction': 'Kamerayı diğer cihazda gösterilen QR koduna doğrultun',
    },
    'nl': {
        'showQrInstruction': 'Open de andere PhotoLynk/Solana Seeker-app, tik op het koppelingspictogram en scan deze QR-code.',
        'scanInstruction': 'Richt de camera op de QR-code die op het andere apparaat wordt weergegeven',
    },
    'sv': {
        'showQrInstruction': 'Öppna den andra PhotoLynk/Solana Seeker-appen, tryck på länkikonen och skanna denna QR-kod.',
        'scanInstruction': 'Rikta kameran mot QR-koden som visas på den andra enheten',
    },
    'da': {
        'showQrInstruction': 'Åbn den anden PhotoLynk/Solana Seeker-app, tryk på linkikonet og scan denne QR-kode.',
        'scanInstruction': 'Ret kameraet mod QR-koden vist på den anden enhed',
    },
    'no': {
        'showQrInstruction': 'Åpne den andre PhotoLynk/Solana Seeker-appen, trykk på koblingsikonet og skann denne QR-koden.',
        'scanInstruction': 'Rett kameraet mot QR-koden som vises på den andre enheten',
    },
    'fi': {
        'showQrInstruction': 'Avaa toinen PhotoLynk/Solana Seeker -sovellus, napauta linkkikuvaketta ja skannaa tämä QR-koodi.',
        'scanInstruction': 'Osoita kamera toisessa laitteessa näkyvään QR-koodiin',
    },
}

def fix_pairing_section(locale_file_path, locale_code):
    """Fix pairing section in a locale file."""
    try:
        with open(locale_file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        if 'pairing' not in data:
            print(f"  ⚠️  No pairing section in {locale_code}")
            return False
        
        if locale_code not in PAIRING_FIXES:
            print(f"  ℹ️  No fixes defined for {locale_code}")
            return False
        
        fixes = PAIRING_FIXES[locale_code]
        changed = False
        
        for key, value in fixes.items():
            if key in data['pairing'] and data['pairing'][key] != value:
                old_val = data['pairing'][key]
                data['pairing'][key] = value
                print(f"  ✓ {key}: {old_val[:50]}... → {value[:50]}...")
                changed = True
        
        if changed:
            with open(locale_file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=4)
            return True
        else:
            print(f"  ✓ No changes needed")
            return False
    
    except Exception as e:
        print(f"  ❌ Error: {e}")
        return False

def main():
    base_dir = Path(__file__).parent
    apps = ['mobile-v2', 'solana-seeker']
    
    for app in apps:
        print(f"\n{'='*60}")
        print(f"Processing {app}")
        print('='*60)
        
        locale_dir = base_dir / app / 'i18n' / 'locales'
        if not locale_dir.exists():
            print(f"❌ Locale directory not found: {locale_dir}")
            continue
        
        locale_files = sorted(locale_dir.glob('*.json'))
        
        for locale_file in locale_files:
            locale_code = locale_file.stem
            print(f"\n{locale_code}.json:")
            fix_pairing_section(locale_file, locale_code)
    
    print(f"\n{'='*60}")
    print("✅ Pairing locale fixes complete")
    print('='*60)

if __name__ == '__main__':
    main()
