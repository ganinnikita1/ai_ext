"""Генератор монохромных иконок «Почерк» в стиле bb (16/32/48/128 PNG).

Тёмный скруглённый квадрат + светлая монограмма «П», hairline-обводка.
Без внешних ассетов и шрифтов: глиф рисуется прямоугольниками.

Запуск: python tools/make_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"

CANVAS = (47, 52, 64)     # #2f3440 — bb canvas
INK = (230, 233, 239)     # #e6e9ef — bb ink
BORDER = (127, 136, 152)  # #7f8898 — hairline

SS = 8  # supersampling factor


def rounded_mask(size: int, radius_ratio: float = 0.25) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * radius_ratio), fill=255)
    return mask


def draw_monogram(size: int) -> Image.Image:
    """Монограмма «П» из трёх прямоугольников — чёткая на 16px."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    glyph_w = size * 0.40
    glyph_h = size * 0.42
    stroke = max(size * 0.085, 1)
    left = (size - glyph_w) / 2
    top = (size - glyph_h) / 2
    right = left + glyph_w
    bottom = top + glyph_h
    draw.rectangle((left, top, left + stroke, bottom), fill=INK)
    draw.rectangle((right - stroke, top, right, bottom), fill=INK)
    draw.rectangle((left, top, right, top + stroke), fill=INK)
    return layer


def render(size: int) -> Image.Image:
    big = size * SS
    base = Image.new("RGBA", (big, big), CANVAS + (255,))
    base.putalpha(rounded_mask(big))
    base.alpha_composite(draw_monogram(big))

    border = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    bdraw = ImageDraw.Draw(border)
    bdraw.rounded_rectangle(
        (0, 0, big - 1, big - 1),
        radius=int(big * 0.25),
        outline=BORDER + (150,),
        width=max(1, int(big * 0.012)),
    )
    base.alpha_composite(border)
    return base.resize((size, size), Image.LANCZOS)


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        icon = render(size)
        path = ICONS / f"icon{size}.png"
        icon.save(path, "PNG", optimize=True)
        print(f"{path.name}: {icon.size[0]}x{icon.size[1]}, mode={icon.mode}, {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
