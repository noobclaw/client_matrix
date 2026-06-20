"""Generate rounded-corner versions of the app icon."""
from PIL import Image, ImageDraw
import os
import shutil

ICONS_DIR = os.path.join(os.path.dirname(__file__), '..', 'build', 'icons')
PNG_DIR = os.path.join(ICONS_DIR, 'png')
WIN_DIR = os.path.join(ICONS_DIR, 'win')
OUTPUT_DIR = os.path.join(ICONS_DIR, 'rounded-preview')
os.makedirs(OUTPUT_DIR, exist_ok=True)

SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
# Corner radius ratio (relative to image size), ~22% like macOS/iOS style
RADIUS_RATIO = 0.22

def make_rounded(img, radius):
    """Apply rounded corners with transparency."""
    img = img.convert('RGBA')
    w, h = img.size
    # Create a mask with rounded corners
    mask = Image.new('L', (w, h), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([(0, 0), (w - 1, h - 1)], radius=radius, fill=255)
    # Apply mask
    result = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    result.paste(img, (0, 0), mask)
    return result

# Process each size
for size in SIZES:
    src = os.path.join(PNG_DIR, f'{size}x{size}.png')
    if not os.path.exists(src):
        continue
    img = Image.open(src)
    radius = max(int(size * RADIUS_RATIO), 2)
    rounded = make_rounded(img, radius)
    out_path = os.path.join(OUTPUT_DIR, f'{size}x{size}.png')
    rounded.save(out_path, 'PNG')
    print(f'  {size}x{size} radius={radius}px -> {out_path}')

# Also generate .ico from the rounded PNGs
ico_sizes = [16, 24, 32, 48, 64, 128, 256]
ico_images = []
for size in ico_sizes:
    p = os.path.join(OUTPUT_DIR, f'{size}x{size}.png')
    if os.path.exists(p):
        ico_images.append(Image.open(p))

if ico_images:
    ico_path = os.path.join(OUTPUT_DIR, 'icon.ico')
    ico_images[0].save(ico_path, format='ICO', sizes=[(im.width, im.height) for im in ico_images], append_images=ico_images[1:])
    print(f'  ICO -> {ico_path}')

print('Done! Preview files in:', OUTPUT_DIR)
