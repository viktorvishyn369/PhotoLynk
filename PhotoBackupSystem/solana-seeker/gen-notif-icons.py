#!/usr/bin/env python3
from PIL import Image
import os

src = Image.open('icon-system-bar.PNG').convert('RGBA')

NOTIFICATION = {
    'drawable-mdpi': 24,
    'drawable-hdpi': 36,
    'drawable-xhdpi': 48,
    'drawable-xxhdpi': 72,
    'drawable-xxxhdpi': 96,
}

base = 'android/app/src/main/res'

gray = src.convert('L')
mean = sum(gray.getdata()) / (gray.width * gray.height)
threshold = max(mean * 0.5, 30)
mask = gray.point(lambda p: 255 if p > threshold else 0, mode='1')

cx, cy = gray.width // 2, gray.height // 2
if gray.getpixel((cx, cy)) > threshold:
    mask = mask.point(lambda p: 0 if p else 255, mode='1')

for folder, size in NOTIFICATION.items():
    out_dir = os.path.join(base, folder)
    os.makedirs(out_dir, exist_ok=True)
    m = mask.resize((size, size), Image.LANCZOS)
    icon = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    white = Image.new('RGBA', (size, size), (255, 255, 255, 255))
    icon.paste(white, (0, 0), m)
    icon.save(os.path.join(out_dir, 'ic_notification.png'), 'PNG')
    print(f'{folder}: {size}x{size}px')

print('Done')
