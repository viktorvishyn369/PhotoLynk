#!/usr/bin/env python3
import json
from pathlib import Path

translations = {
    'ar': 'جارٍ استعادة حسابك...',
    'bg': 'Възстановяване на вашия акаунт...',
    'cs': 'Obnovování vašeho účtu...',
    'da': 'Gendanner din konto...',
    'de': 'Dein Konto wird wiederhergestellt...',
    'el': 'Επαναφορά του λογαριασμού σας...',
    'en': 'Restoring your account...',
    'en-GB': 'Restoring your account...',
    'es': 'Restaurando tu cuenta...',
    'et': 'Teie konto taastamine...',
    'fi': 'Palautetaan tiliäsi...',
    'fr': 'Restauration de votre compte...',
    'hi': 'आपका खाता पुनर्स्थापित किया जा रहा है...',
    'hr': 'Obnavljanje vašeg računa...',
    'hu': 'Fiókja visszaállítása folyamatban...',
    'id': 'Memulihkan akun Anda...',
    'it': 'Ripristino del tuo account...',
    'ja': 'アカウントを復元しています...',
    'ko': '계정을 복원하는 중입니다...',
    'lt': 'Atkuriama jūsų paskyra...',
    'lv': 'Jūsu konts tiek atjaunots...',
    'nl': 'Je account wordt hersteld...',
    'no': 'Gjenoppretter kontoen din...',
    'pl': 'Przywracanie Twojego konta...',
    'pt': 'A restaurar a sua conta...',
    'pt-BR': 'Restaurando sua conta...',
    'ro': 'Se restaurează contul dvs....',
    'ru': 'Восстановление вашего аккаунта...',
    'sv': 'Återställer ditt konto...',
    'tr': 'Hesabınız geri yükleniyor...',
    'uk': 'Відновлення вашого акаунта...',
    'zh': '正在恢复你的账户...'
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
        pairing['restoringAccount'] = translation
        path.write_text(json.dumps(data, ensure_ascii=False, indent=4) + '\n', encoding='utf-8')
        updated += 1
        print(f'updated {path}')

print(f'completed: {updated} locale files updated')
