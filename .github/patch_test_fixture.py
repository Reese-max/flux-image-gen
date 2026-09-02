from pathlib import Path

path = Path(__file__).resolve().parents[1] / "tests" / "test_static_ui.py"
text = path.read_text(encoding="utf-8")
old = '        "canvas-viewport.js",\n        "elapsed-timer.js",\n'
new = '        "canvas-viewport.js",\n        "download-utils.js",\n        "elapsed-timer.js",\n'
count = text.count(old)
if count != 1:
    raise RuntimeError(f"expected exactly one production JS fixture match, found {count}")
path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")
print("Added download-utils.js to the production JS fixture.")
