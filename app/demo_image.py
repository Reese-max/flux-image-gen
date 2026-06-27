from __future__ import annotations

import base64
import hashlib
from io import BytesIO
from textwrap import wrap

from PIL import Image, ImageDraw, ImageFont


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "C:/Windows/Fonts/msjh.ttc",
        "C:/Windows/Fonts/mingliu.ttc",
        "C:/Windows/Fonts/arial.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_demo_png_data_url(prompt: str, width: int, height: int, model: str) -> str:
    digest = hashlib.sha256(f"{prompt}|{width}|{height}|{model}".encode("utf-8")).digest()
    c1 = (digest[0], digest[1], digest[2])
    c2 = (digest[3], digest[4], digest[5])
    c3 = (digest[6], digest[7], digest[8])

    image = Image.new("RGB", (width, height), c1)
    px = image.load()
    for y in range(height):
        yr = y / max(height - 1, 1)
        for x in range(width):
            xr = x / max(width - 1, 1)
            glow = ((x - width * 0.72) ** 2 + (y - height * 0.22) ** 2) ** 0.5
            glow = max(0.0, 1.0 - glow / (max(width, height) * 0.72))
            r = int(c1[0] * (1 - xr) + c2[0] * xr + c3[0] * glow * 0.45)
            g = int(c1[1] * (1 - yr) + c2[1] * yr + c3[1] * glow * 0.45)
            b = int(c1[2] * (1 - (xr + yr) / 2) + c2[2] * ((xr + yr) / 2) + c3[2] * glow * 0.45)
            px[x, y] = (min(r, 255), min(g, 255), min(b, 255))

    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    margin = max(32, width // 18)
    box_h = max(210, height // 4)
    box_y = height - box_h - margin
    draw.rounded_rectangle(
        (margin, box_y, width - margin, height - margin),
        radius=28,
        fill=(15, 23, 42, 210),
        outline=(148, 163, 184, 90),
        width=2,
    )

    body_font_size = max(20, width // 48)
    title_font = _load_font(max(28, width // 30))
    body_font = _load_font(body_font_size)
    small_font = _load_font(max(16, width // 62))
    draw.text((margin + 28, box_y + 24), "Demo Image", font=title_font, fill=(226, 232, 240, 255))
    draw.text(
        (margin + 28, box_y + 76),
        f"{model.upper()} fallback · {width}×{height}",
        font=small_font,
        fill=(196, 181, 253, 255),
    )

    safe_prompt = " ".join(prompt.split())[:260]
    lines = wrap(safe_prompt, width=42)
    y = box_y + 116
    for line in lines[:4]:
        draw.text((margin + 28, y), line, font=body_font, fill=(203, 213, 225, 255))
        y += int(body_font_size * 1.35)

    image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
    buf = BytesIO()
    image.save(buf, format="PNG", optimize=True)
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return "data:image/png;base64," + encoded
