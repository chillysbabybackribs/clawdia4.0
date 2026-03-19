#!/usr/bin/env python3
"""
Screenshot Analyzer — OCR + structural extraction for GUI automation.

Returns ~400-600 tokens of structured JSON instead of 50,000+ tokens from raw vision.
Called by Clawdia's desktop executor after capturing a screenshot.

Pipeline:
  1. Capture (scrot) or load existing image
  2. Multi-strategy OCR with fallback (not one-shot)
  3. Button/click target extraction on narrow strips
  4. OpenCV dialog detection (5-criteria gate)
  5. Structured JSON to stdout

Usage:
  python3 screenshot-analyzer.py                              # full screen capture
  python3 screenshot-analyzer.py --file /tmp/cap.png          # analyze existing file
  python3 screenshot-analyzer.py --region 400,200,800,400     # capture region only
  python3 screenshot-analyzer.py --title "GIMP"               # pass known window title
  python3 screenshot-analyzer.py --nocache                    # skip target cache

All output goes to stdout as JSON. Errors go to stderr only.
"""

import sys
import os
import json
import subprocess
import time
from pathlib import Path

# ── Imports with graceful failure ────────────────────────

try:
    import pytesseract
    from PIL import Image, ImageEnhance, ImageFilter, ImageOps
    import cv2
    import numpy as np
    HAS_DEPS = True
except ImportError as e:
    HAS_DEPS = False
    MISSING_DEP = str(e)

# ── Constants ────────────────────────────────────────────

BUTTON_VOCAB = frozenset([
    "OK", "Ok", "Cancel", "Save", "Open", "Close", "Yes", "No",
    "Apply", "Export", "Import", "Delete", "Confirm", "Submit",
    "Next", "Back", "Finish", "Skip", "Retry", "Ignore", "Continue",
    "Browse", "Accept", "Decline", "Replace", "Overwrite", "Discard",
    "Revert", "Reset", "Quit", "Exit", "Help", "About", "Preferences",
    "Settings", "Properties", "Advanced", "Options", "Select", "Choose",
    "Create", "New", "Edit", "Remove", "Add", "Insert", "Rename",
    "File", "View", "Image", "Layer", "Colors", "Tools", "Filters",
    "Windows", "Script-Fu", "Python-Fu", "Fonts",
])

BUTTON_VOCAB_LOWER = frozenset(w.lower() for w in BUTTON_VOCAB)

MIN_CONFIDENCE = 40          # Lowered from 55 — GUI text is harder than documents
OCR_SCALE_LARGE = 0.75       # For images > 2000px wide (was 0.5 — too aggressive)
OCR_SCALE_NORMAL = 1.0       # For images <= 2000px wide — no downscale
STRIP_TOP_PX = 80            # Increased from 60 — some apps have taller menu+toolbar
STRIP_BOTTOM_PX = 100        # Increased from 80 — button rows can be tall

# Dialog detection thresholds
DIALOG_MIN_WIDTH_PCT = 0.20
DIALOG_MAX_WIDTH_PCT = 0.80
DIALOG_MIN_HEIGHT_PCT = 0.15
DIALOG_MAX_HEIGHT_PCT = 0.70
DIALOG_ASPECT_MIN = 0.5
DIALOG_ASPECT_MAX = 3.0
DIALOG_CENTER_MARGIN_PCT = 0.20


# ── Preprocessing ────────────────────────────────────────

def preprocess_light(img: Image.Image) -> Image.Image:
    """Light preprocessing: greyscale + mild contrast boost. Best for bright themes."""
    grey = img.convert('L')
    enhancer = ImageEnhance.Contrast(grey)
    return enhancer.enhance(1.4)


def preprocess_dark(img: Image.Image) -> Image.Image:
    """Dark theme preprocessing: invert + adaptive threshold."""
    grey = img.convert('L')
    arr = np.array(grey)
    arr = 255 - arr
    arr = cv2.adaptiveThreshold(
        arr, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY, 21, 10
    )
    return Image.fromarray(arr)


def preprocess_adaptive(img: Image.Image) -> Image.Image:
    """Adaptive threshold without inversion. Good for mixed themes."""
    grey = img.convert('L')
    enhancer = ImageEnhance.Contrast(grey)
    grey = enhancer.enhance(1.5)
    arr = np.array(grey)
    arr = cv2.adaptiveThreshold(
        arr, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY, 15, 8
    )
    return Image.fromarray(arr)


def smart_scale(img: Image.Image) -> Image.Image:
    """Scale image for OCR — only downscale if very large."""
    w, h = img.size
    if w > 2000:
        scale = OCR_SCALE_LARGE
        return img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    return img  # No scaling for normal-sized images


# ── Multi-strategy OCR ───────────────────────────────────

def run_ocr_pass(img: Image.Image, psm: int = 3) -> tuple[str, list[dict]]:
    """Run tesseract on a preprocessed image. Returns (text, elements)."""
    data = pytesseract.image_to_data(
        img, config=f'--psm {psm}', output_type=pytesseract.Output.DICT
    )

    elements = []
    seen = set()
    n = len(data['text'])

    for i in range(n):
        text = data['text'][i].strip()
        conf = int(data['conf'][i]) if str(data['conf'][i]) != '-1' else 0
        if not text or conf < MIN_CONFIDENCE:
            continue

        x = data['left'][i]
        y = data['top'][i]
        w = data['width'][i]
        h = data['height'][i]

        key = f"{text.lower()}_{x // 20}_{y // 20}"
        if key in seen:
            continue
        seen.add(key)

        elements.append({'text': text, 'x': x, 'y': y, 'w': w, 'h': h, 'conf': conf})

    return '', elements


def pass1_full_text(img: Image.Image) -> tuple[str, list[dict]]:
    """
    Multi-strategy OCR on full image. Tries multiple preprocessing methods
    and picks the one that extracts the most text. Uses PSM 3 (auto) for
    GUI screenshots instead of PSM 6 (uniform block).
    """
    scaled = smart_scale(img)
    scale_factor = img.size[0] / scaled.size[0]  # To map coords back

    strategies = [
        ('light', preprocess_light(scaled)),
        ('adaptive', preprocess_adaptive(scaled)),
        ('dark', preprocess_dark(scaled)),
    ]

    best_elements = []
    best_strategy = ''

    for name, processed in strategies:
        _, elements = run_ocr_pass(processed, psm=3)
        if len(elements) > len(best_elements):
            best_elements = elements
            best_strategy = name

    # If best strategy found very little, also try PSM 11 (sparse) as fallback
    if len(best_elements) < 5:
        for name, processed in strategies:
            _, elements = run_ocr_pass(processed, psm=11)
            if len(elements) > len(best_elements):
                best_elements = elements
                best_strategy = f'{name}+sparse'

    # Scale coordinates back to original resolution
    if scale_factor != 1.0:
        for el in best_elements:
            el['x'] = int(el['x'] * scale_factor)
            el['y'] = int(el['y'] * scale_factor)
            el['w'] = int(el['w'] * scale_factor)
            el['h'] = int(el['h'] * scale_factor)

    # Build clean text output (line-grouped by y-coordinate)
    best_elements.sort(key=lambda e: (e['y'] // 15, e['x']))
    text_lines = []
    current_y = -100
    current_line = []
    for el in best_elements:
        if abs(el['y'] - current_y) > 15:
            if current_line:
                text_lines.append(' '.join(current_line))
            current_line = [el['text']]
            current_y = el['y']
        else:
            current_line.append(el['text'])
    if current_line:
        text_lines.append(' '.join(current_line))

    clean_text = '\n'.join(line for line in text_lines if line.strip())

    # Log which strategy won (to stderr for debugging)
    print(f'[OCR] Best strategy: {best_strategy} ({len(best_elements)} elements)', file=sys.stderr)

    return clean_text, best_elements


# ── Pass 2: Button/click target extraction ───────────────

def pass2_click_targets(img: Image.Image, orig_h: int) -> list[dict]:
    """
    PSM 11 (sparse) on narrow strips: top strip + bottom strip.
    Returns words matching BUTTON_VOCAB with coordinates.
    Also scans a middle band if a dialog was detected nearby.
    """
    w, h = img.size
    targets = []

    strips = [
        (0, 0, w, min(STRIP_TOP_PX, h), 0, 0),
        (0, max(0, h - STRIP_BOTTOM_PX), w, h, 0, max(0, h - STRIP_BOTTOM_PX)),
    ]

    for sx, sy, sw, sh, offset_x, offset_y in strips:
        strip_img = img.crop((sx, sy, sw, sh))
        if strip_img.size[0] < 10 or strip_img.size[1] < 10:
            continue

        # Try both light and dark preprocessing on strips
        for preprocess_fn in [preprocess_light, preprocess_dark]:
            processed = preprocess_fn(strip_img)
            data = pytesseract.image_to_data(
                processed, config='--psm 11', output_type=pytesseract.Output.DICT
            )

            n = len(data['text'])
            for i in range(n):
                text = data['text'][i].strip()
                conf = int(data['conf'][i]) if str(data['conf'][i]) != '-1' else 0
                if not text or conf < MIN_CONFIDENCE:
                    continue

                if text.lower() in BUTTON_VOCAB_LOWER:
                    cx = data['left'][i] + data['width'][i] // 2 + offset_x
                    cy = data['top'][i] + data['height'][i] // 2 + offset_y
                    targets.append({'label': text, 'x': cx, 'y': cy, 'conf': conf})

    # Deduplicate targets (same label within 30px)
    deduped = []
    for t in targets:
        duplicate = False
        for existing in deduped:
            if (existing['label'].lower() == t['label'].lower()
                    and abs(existing['x'] - t['x']) < 30
                    and abs(existing['y'] - t['y']) < 30):
                # Keep higher confidence one
                if t.get('conf', 0) > existing.get('conf', 0):
                    existing.update(t)
                duplicate = True
                break
        if not duplicate:
            deduped.append(t)

    # Remove internal conf field from output
    for t in deduped:
        t.pop('conf', None)

    return deduped


# ── Dialog detection ─────────────────────────────────────

def detect_dialog(img: Image.Image) -> dict | None:
    """OpenCV rectangle detection with 5-criteria gate."""
    arr = np.array(img.convert('L'))
    h, w = arr.shape

    edges = cv2.Canny(arr, 50, 150)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    edges = cv2.dilate(edges, kernel, iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    best_dialog = None
    best_area = 0

    for contour in contours:
        x, y, bw, bh = cv2.boundingRect(contour)
        area = bw * bh
        if area < (w * h * 0.02) or area > (w * h * 0.85):
            continue
        if not (DIALOG_MIN_WIDTH_PCT * w <= bw <= DIALOG_MAX_WIDTH_PCT * w):
            continue
        if not (DIALOG_MIN_HEIGHT_PCT * h <= bh <= DIALOG_MAX_HEIGHT_PCT * h):
            continue
        aspect = bw / max(bh, 1)
        if not (DIALOG_ASPECT_MIN <= aspect <= DIALOG_ASPECT_MAX):
            continue
        cx = x + bw // 2
        cy = y + bh // 2
        margin_x = w * DIALOG_CENTER_MARGIN_PCT
        margin_y = h * DIALOG_CENTER_MARGIN_PCT
        if not (margin_x <= cx <= w - margin_x and margin_y <= cy <= h - margin_y):
            continue

        interior = arr[y:y + bh, x:x + bw]
        interior_mean = interior.mean()
        mask = np.ones_like(arr, dtype=bool)
        mask[y:y + bh, x:x + bw] = False
        exterior_mean = arr[mask].mean() if mask.any() else interior_mean
        if interior_mean < exterior_mean + 10:
            continue

        if area > best_area:
            best_area = area
            best_dialog = {
                'region': [int(x), int(y), int(bw), int(bh)],
                'center': [int(cx), int(cy)],
            }

    return best_dialog


# ── Menu bar extraction ──────────────────────────────────

def extract_menu(elements: list[dict], max_y: int = 40) -> str:
    """Extract menu bar items from Pass 1 elements (y < max_y, short height)."""
    menu_items = [
        el['text'] for el in elements
        if el['y'] < max_y and el['h'] < 30 and len(el['text']) > 1
    ]
    noise = {'desktop', 'icons', 'activities', 'ubuntu', 'the', 'and', 'for'}
    menu_items = [m for m in menu_items if m.lower() not in noise]
    return ' | '.join(menu_items) if menu_items else ''


# ── Screenshot capture ───────────────────────────────────

def capture_screenshot(region: tuple[int, int, int, int] | None = None) -> str:
    """Capture screenshot with scrot. Returns file path."""
    filename = f'/tmp/clawdia-ocr-{int(time.time() * 1000)}.png'
    if region:
        x, y, w, h = region
        cmd = ['scrot', '-a', f'{x},{y},{w},{h}', filename]
    else:
        cmd = ['scrot', filename]

    result = subprocess.run(cmd, capture_output=True, timeout=5)
    if result.returncode != 0:
        raise RuntimeError(f'scrot failed: {result.stderr.decode().strip()}')
    return filename


# ── Coordinate offset for region captures ────────────────

def apply_region_offset(targets: list[dict], elements: list[dict],
                        dialog: dict | None, region: tuple | None) -> None:
    """Add region x,y offset to all coordinates so they become absolute."""
    if not region:
        return
    ox, oy = region[0], region[1]
    for t in targets:
        t['x'] += ox
        t['y'] += oy
    for el in elements:
        el['x'] += ox
        el['y'] += oy
    if dialog:
        dialog['region'][0] += ox
        dialog['region'][1] += oy
        dialog['center'][0] += ox
        dialog['center'][1] += oy


# ── Main pipeline ────────────────────────────────────────

def analyze(image_path: str, region: tuple | None = None,
            title: str = '') -> dict:
    """Full analysis pipeline. Returns structured dict."""
    img = Image.open(image_path)
    orig_w, orig_h = img.size

    # Pass 1: Full text + elements (multi-strategy)
    full_text, elements = pass1_full_text(img)

    # Pass 2: Click targets from narrow strips
    targets = pass2_click_targets(img, orig_h)

    # Dialog detection
    dialog = detect_dialog(img)

    # If dialog detected, run extra OCR on the dialog region
    if dialog:
        dr = dialog['region']
        dialog_img = img.crop((dr[0], dr[1], dr[0] + dr[2], dr[1] + dr[3]))
        dialog_targets = pass2_click_targets(dialog_img, dr[3])
        for dt in dialog_targets:
            dt['x'] += dr[0]
            dt['y'] += dr[1]
        existing_labels = {t['label'].lower() for t in targets}
        for dt in dialog_targets:
            if dt['label'].lower() not in existing_labels:
                targets.append(dt)

        # OCR dialog text content
        for preprocess_fn in [preprocess_light, preprocess_dark, preprocess_adaptive]:
            processed = preprocess_fn(dialog_img)
            dialog_text = pytesseract.image_to_string(processed, config='--psm 3').strip()
            if dialog_text and len(dialog_text) > 10:
                lines = [l.strip() for l in dialog_text.split('\n') if l.strip()]
                dialog['text'] = '\n'.join(lines[:10])
                break

    # Menu bar
    menu = extract_menu(elements)

    # Window title
    window_title = title
    if not window_title and elements:
        top_elements = [e for e in elements if e['y'] < 35]
        if top_elements:
            window_title = ' '.join(e['text'] for e in top_elements[:8])

    # Apply region offset
    apply_region_offset(targets, elements, dialog, region)

    # Build output
    output = {
        'window': window_title,
        'size': f'{orig_w}x{orig_h}',
    }
    if menu:
        output['menu'] = menu
    if dialog:
        output['dialog'] = dialog

    # Clean text
    text_lines = [l for l in full_text.split('\n') if l.strip()]
    clean_text = '\n'.join(text_lines[:40])
    if len(clean_text) > 2000:
        clean_text = clean_text[:2000] + '\n[truncated]'
    output['text'] = clean_text

    if targets:
        output['targets'] = targets

    # Diagnostic: if we got very little text, note it
    if len(elements) < 3:
        output['_diagnostic'] = f'Low OCR yield ({len(elements)} elements). May need different preprocessing for this app/theme.'

    # Token estimate
    json_str = json.dumps(output, ensure_ascii=False)
    output['tokens_est'] = len(json_str) // 3

    return output


# ── CLI ──────────────────────────────────────────────────

def parse_args(argv: list[str]) -> dict:
    args = {'file': None, 'region': None, 'title': '', 'nocache': False}
    i = 1
    while i < len(argv):
        arg = argv[i]
        if arg == '--file' and i + 1 < len(argv):
            args['file'] = argv[i + 1]
            i += 2
        elif arg == '--region' and i + 1 < len(argv):
            parts = argv[i + 1].split(',')
            if len(parts) == 4:
                args['region'] = tuple(int(p) for p in parts)
            i += 2
        elif arg == '--title' and i + 1 < len(argv):
            args['title'] = argv[i + 1]
            i += 2
        elif arg == '--nocache':
            args['nocache'] = True
            i += 1
        else:
            print(f'Unknown argument: {arg}', file=sys.stderr)
            i += 1
    return args


def main():
    if not HAS_DEPS:
        print(json.dumps({'error': f'Missing dependency: {MISSING_DEP}'}))
        sys.exit(1)

    args = parse_args(sys.argv)

    try:
        if args['file']:
            image_path = args['file']
            if not os.path.exists(image_path):
                print(json.dumps({'error': f'File not found: {image_path}'}))
                sys.exit(1)
        else:
            image_path = capture_screenshot(args['region'])

        result = analyze(image_path, region=args['region'], title=args['title'])
        print(json.dumps(result, ensure_ascii=False, indent=None))

    except Exception as e:
        print(f'Analysis error: {e}', file=sys.stderr)
        print(json.dumps({'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
