#!/usr/bin/env python3
"""
Test the screenshot analyzer directly.

Run:
  python3 tests/test-screenshot-analyzer.py

Prerequisites:
  - X11 session with at least one window open
  - scrot, tesseract, pytesseract, Pillow, OpenCV installed
"""

import subprocess
import sys
import json
import os
import time

ANALYZER = os.path.join(
    os.path.dirname(__file__), '..', 'src', 'main', 'agent', 'gui', 'screenshot-analyzer.py'
)

passed = 0
failed = 0

def test(condition, label):
    global passed, failed
    if condition:
        passed += 1
        print(f'  ✅ {label}')
    else:
        failed += 1
        print(f'  ❌ {label}')

def section(name):
    print(f'\n━━━ {name} ━━━')

def run_analyzer(*args):
    """Run the analyzer and return parsed JSON (parses stdout even on non-zero exit)."""
    cmd = ['python3', ANALYZER] + list(args)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30,
                           env={**os.environ, 'DISPLAY': os.environ.get('DISPLAY', ':0')})
    if result.stderr.strip():
        print(f'  stderr: {result.stderr.strip()}')
    # Try to parse stdout even on non-zero exit (error JSON is still valid output)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        if result.returncode != 0:
            print(f'  Non-zero exit ({result.returncode}), no valid JSON')
        else:
            print(f'  Invalid JSON: {result.stdout[:200]}')
        return None


# ── Test 1: Script exists and imports work ─────────────

section('Prerequisites')
test(os.path.exists(ANALYZER), f'Analyzer script exists at {ANALYZER}')

result = subprocess.run(
    ['python3', '-c', 'import pytesseract, cv2; from PIL import Image; print("ok")'],
    capture_output=True, text=True, timeout=5
)
test(result.stdout.strip() == 'ok', 'Python deps available (pytesseract, cv2, PIL)')


# ── Test 2: Capture and analyze full screen ────────────

section('Full Screen Capture + Analysis')
data = run_analyzer()
test(data is not None, 'Analyzer returned valid JSON')
if data:
    test('size' in data, f'Has size field: {data.get("size", "MISSING")}')
    test('text' in data, 'Has text field')
    test('tokens_est' in data, f'Has token estimate: {data.get("tokens_est", "MISSING")}')
    test(data.get('tokens_est', 99999) < 2000, f'Token estimate under 2000: {data.get("tokens_est")}')
    
    text_len = len(data.get('text', ''))
    test(text_len > 0, f'OCR found text ({text_len} chars)')
    
    if data.get('menu'):
        test(True, f'Menu detected: {data["menu"][:80]}')
    else:
        print('  ℹ️  No menu bar detected (may be expected depending on active window)')
    
    if data.get('targets'):
        test(True, f'Found {len(data["targets"])} click targets')
        for t in data['targets'][:5]:
            print(f'    "{t["label"]}" at ({t["x"]}, {t["y"]})')
    else:
        print('  ℹ️  No button targets found (may be expected)')
    
    if data.get('dialog'):
        test(True, f'Dialog detected: {data["dialog"]}')
    else:
        print('  ℹ️  No dialog detected (expected if no dialog is open)')
    
    # Print full output for inspection
    print(f'\n  Full output ({len(json.dumps(data))} chars):')
    for line in json.dumps(data, indent=2).split('\n')[:30]:
        print(f'    {line}')


# ── Test 3: Analyze existing file ──────────────────────

section('Analyze Existing File')
# Capture a screenshot first, then analyze it
cap_file = f'/tmp/clawdia-test-cap-{int(time.time())}.png'
subprocess.run(['scrot', cap_file], capture_output=True, timeout=5,
              env={**os.environ, 'DISPLAY': os.environ.get('DISPLAY', ':0')})

if os.path.exists(cap_file):
    data2 = run_analyzer('--file', cap_file)
    test(data2 is not None, 'Analyzer works with --file flag')
    if data2:
        test('text' in data2, 'Has text in --file mode')
        test('tokens_est' in data2, f'Token estimate: {data2.get("tokens_est")}')
    os.remove(cap_file)
else:
    print('  ⚠️  Could not capture test screenshot (scrot failed)')


# ── Test 4: Title passthrough ──────────────────────────

section('Title Passthrough')
cap_file2 = f'/tmp/clawdia-test-cap2-{int(time.time())}.png'
subprocess.run(['scrot', cap_file2], capture_output=True, timeout=5,
              env={**os.environ, 'DISPLAY': os.environ.get('DISPLAY', ':0')})

if os.path.exists(cap_file2):
    data3 = run_analyzer('--file', cap_file2, '--title', 'Test Window Title')
    test(data3 is not None, 'Analyzer works with --title flag')
    if data3:
        test(data3.get('window') == 'Test Window Title', f'Title passed through: {data3.get("window")}')
    os.remove(cap_file2)


# ── Test 5: Error handling ─────────────────────────────

section('Error Handling')
data_err = run_analyzer('--file', '/tmp/nonexistent-file-12345.png')
test(data_err is not None and 'error' in data_err, 'Returns error JSON for missing file')


# ── Results ────────────────────────────────────────────

print('\n' + '═' * 50)
print(f'Results: {passed} passed, {failed} failed')
if failed > 0:
    sys.exit(1)
else:
    print('\n🎉 All tests passed!')
    sys.exit(0)
