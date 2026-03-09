#!/usr/bin/env python3
import json
from pathlib import Path

translations = {
    'ar': 'تمت مشاركته على الجهاز الآخر',
    'bg': 'Споделено на другото устройство',
    'cs': 'Sdíleno na druhém zařízení',
    'da': 'Delt på den anden enhed',
    'de': 'Auf dem anderen Gerät geteilt',
    'el': 'Κοινοποιήθηκε στην άλλη συσκευή',
    'en': 'Shared on the other device',
    'en-GB': 'Shared on the other device',
    'es': 'Compartido en el otro dispositivo',
    'et': 'Jagatud teises seadmes',
    'fi': 'Jaettu toisella laitteella',
    'fr': 'Partagé sur l’autre appareil',
    'hi': 'दूसरे डिवाइस पर साझा किया गया',
    'hr': 'Podijeljeno na drugom uređaju',
    'hu': 'A másik eszközön megosztva',
    'id': 'Dibagikan di perangkat lain',
    'it': 'Condiviso sull’altro dispositivo',
    'ja': '別のデバイスで共有済み',
    'ko': '다른 기기에서 공유됨',
    'lt': 'Bendrinama kitame įrenginyje',
    'lv': 'Kopīgots citā ierīcē',
    'nl': 'Gedeeld op het andere apparaat',
    'no': 'Delt på den andre enheten',
    'pl': 'Udostępniono na drugim urządzeniu',
    'pt': 'Partilhado no outro dispositivo',
    'pt-BR': 'Compartilhado no outro dispositivo',
    'ro': 'Partajat pe celălalt dispozitiv',
    'ru': 'Общий доступ на другом устройстве',
    'sv': 'Delat på den andra enheten',
    'tr': 'Diğer cihazda paylaşıldı',
    'uk': 'Надано доступ на іншому пристрої',
    'zh': '已在另一台设备上共享'
}

root = Path(__file__).resolve().parent
locale_roots = [
    root / 'mobile-v2' / 'i18n' / 'locales',
    root / 'solana-seeker' / 'i18n' / 'locales',
]

updated = 0
for locale_root in locale_roots:
    for path in sorted(locale_root.glob('*.json')):
        code = path.stem
        translation = translations.get(code)
        if not translation:
            print(f'skip {path.name}: no translation configured')
            continue
        data = json.loads(path.read_text(encoding='utf-8'))
        pairing = data.get('pairing')
        if not isinstance(pairing, dict):
            print(f'skip {path}: no pairing section')
            continue
        pairing['sharedOnOtherDevice'] = translation
        path.write_text(json.dumps(data, ensure_ascii=False, indent=4) + '\n', encoding='utf-8')
        updated += 1
        print(f'updated {path}')

print(f'completed: {updated} locale files updated')
