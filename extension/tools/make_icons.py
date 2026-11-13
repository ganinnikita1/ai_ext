"""Генератор монохромных иконок «AI Bro» в стиле bb (16/32/48/128 PNG).

Тёмный скруглённый квадрат + светлая монограмма «AB», hairline-обводка.
Без внешних ассетов и шрифтов: глифы рисуются линиями/прямоугольниками.

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
    """Монограмма «AB»: A — линии, B — вертикаль + две скруглённые чаши."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    stroke = max(round(size * 0.075), 1)
    total_w = size * 0.56
    glyph_h = size * 0.42
    gap = size * 0.055
    letter_w = (total_w - gap) / 2
    left = (size - total_w) / 2
    top = (size - glyph_h) / 2
    bottom = top + glyph_h

    # A
    ax = left
    apex_x = ax + letter_w / 2
    draw.line((ax, bottom, apex_x, top), fill=INK, width=stroke, joint="curve")
    draw.line((apex_x, top, ax + letter_w, bottom), fill=INK, width=stroke, joint="curve")
    cross_y = top + glyph_h * 0.62
    draw.line(
        (ax + letter_w * 0.22, cross_y, ax + letter_w * 0.78, cross_y),
        fill=INK,
        width=stroke,
    )

    # B
    bx = left + letter_w + gap
    draw.line((bx, top, bx, bottom), fill=INK, width=stroke)
    bowl_w = letter_w * 0.78
    draw.rounded_rectangle(
        (bx, top, bx + bowl_w, top + glyph_h * 0.48),
        radius=max(int(letter_w * 0.22), 1),
        outline=INK,
        width=stroke,
    )
    draw.rounded_rectangle(
        (bx, top + glyph_h * 0.44, bx + bowl_w * 1.02, bottom),
        radius=max(int(letter_w * 0.22), 1),
        outline=INK,
        width=stroke,
    )
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
