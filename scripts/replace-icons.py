"""Replace all icon files with rounded-corner versions."""
from PIL import Image, ImageDraw
import os
import struct

ICONS_DIR = os.path.join(os.path.dirname(__file__), '..', 'build', 'icons')
PNG_DIR = os.path.join(ICONS_DIR, 'png')
WIN_DIR = os.path.join(ICONS_DIR, 'win')
MAC_DIR = os.path.join(ICONS_DIR, 'mac')
PREVIEW_DIR = os.path.join(ICONS_DIR, 'rounded-preview')

# Also handle resources/icon.ico and resources/tray/tray-icon.ico
RES_DIR = os.path.join(os.path.dirname(__file__), '..', 'resources')

SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

# 1. Replace PNG files
print("=== Replacing PNGs ===")
for size in SIZES:
    src = os.path.join(PREVIEW_DIR, f'{size}x{size}.png')
    dst = os.path.join(PNG_DIR, f'{size}x{size}.png')
    if os.path.exists(src) and os.path.exists(dst):
        with open(src, 'rb') as f:
            data = f.read()
        with open(dst, 'wb') as f:
            f.write(data)
        print(f'  Replaced {size}x{size}.png')

# 2. Replace Windows ICO
print("=== Replacing Windows ICO ===")
ico_src = os.path.join(PREVIEW_DIR, 'icon.ico')
ico_dst = os.path.join(WIN_DIR, 'icon.ico')
if os.path.exists(ico_src):
    with open(ico_src, 'rb') as f:
        data = f.read()
    with open(ico_dst, 'wb') as f:
        f.write(data)
    print(f'  Replaced {ico_dst}')

# Also replace resources/icon.ico
res_ico = os.path.join(RES_DIR, 'icon.ico')
if os.path.exists(res_ico):
    with open(ico_src, 'rb') as f:
        data = f.read()
    with open(res_ico, 'wb') as f:
        f.write(data)
    print(f'  Replaced {res_ico}')

# 3. Generate macOS ICNS
print("=== Generating macOS ICNS ===")

def create_icns(output_path, png_dir):
    """Create an ICNS file from rounded PNG files."""
    # ICNS icon types and their sizes
    icns_types = [
        (b'ic07', 128),   # 128x128
        (b'ic08', 256),   # 256x256
        (b'ic09', 512),   # 512x512
        (b'ic10', 1024),  # 1024x1024 (512x512@2x)
        (b'ic11', 32),    # 16x16@2x
        (b'ic12', 64),    # 32x32@2x
        (b'ic13', 256),   # 128x128@2x
        (b'ic14', 512),   # 256x256@2x
    ]

    entries = []
    for icon_type, size in icns_types:
        png_path = os.path.join(png_dir, f'{size}x{size}.png')
        if not os.path.exists(png_path):
            continue
        with open(png_path, 'rb') as f:
            png_data = f.read()
        # Each entry: type (4 bytes) + length (4 bytes) + data
        entry_length = 8 + len(png_data)
        entry = icon_type + struct.pack('>I', entry_length) + png_data
        entries.append(entry)
        print(f'  Added {icon_type.decode()} ({size}x{size})')

    if not entries:
        print('  No entries to write!')
        return

    # ICNS header: 'icns' + total file length
    body = b''.join(entries)
    total_length = 8 + len(body)
    icns_data = b'icns' + struct.pack('>I', total_length) + body

    with open(output_path, 'wb') as f:
        f.write(icns_data)
    print(f'  Written {output_path} ({total_length} bytes)')

icns_path = os.path.join(MAC_DIR, 'icon.icns')
create_icns(icns_path, PREVIEW_DIR)

print("\nAll icons replaced!")
