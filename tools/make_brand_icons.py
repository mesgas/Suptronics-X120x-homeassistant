#!/usr/bin/env python3
"""Render the integration's brand icons.

Since Home Assistant 2026.3 a custom integration carries its own brand images
in a brand/ folder next to its manifest, served through the Brands Proxy API.
Pull requests to home-assistant/brands are no longer accepted for custom
components, so nothing here leaves the repository.

    python3 make_brand_icons.py [output_dir]

Writes icon.png (256x256) and icon@2x.png (512x512) into
custom_components/x120x/brand by default: transparent, drawn at 8x and
downsampled so the edges stay clean, and with no transparent border.

Requires Pillow.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

# Work at 8x the 256px target, then downsample: cheap, very effective
# antialiasing without pulling in a vector rasteriser.
SCALE = 8
SIZE = 256 * SCALE

BADGE_DARK = (17, 22, 32, 255)
BADGE_LIGHT = (30, 40, 54, 255)
TEAL = (79, 209, 197, 255)
TEAL_DEEP = (45, 168, 158, 255)
BOLT = (13, 19, 28, 255)


def u(value: float) -> int:
    """Map a coordinate given on a 0-100 grid to working pixels."""
    return round(value / 100 * SIZE)


def vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    """A one-pixel-wide gradient stretched to a square."""
    strip = Image.new("RGBA", (1, size))
    pixels = strip.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        pixels[0, y] = tuple(
            round(top[channel] + (bottom[channel] - top[channel]) * t)
            for channel in range(4)
        )
    return strip.resize((size, size), Image.BILINEAR)


def build() -> Image.Image:
    """Draw the mark: a board-shaped badge holding a battery cell and a bolt."""
    # --- badge -----------------------------------------------------------
    # Full bleed, deliberately: a transparent border would show up as slack
    # space wherever the icon is boxed, so the badge touches all four edges.
    badge_mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(badge_mask).rounded_rectangle(
        [0, 0, SIZE - 1, SIZE - 1], radius=u(22), fill=255
    )
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(vertical_gradient(SIZE, BADGE_LIGHT, BADGE_DARK), (0, 0), badge_mask)

    # A teal hairline keeps the badge from dissolving into a dark dashboard.
    # Inset by half its own width so the stroke stays fully inside the canvas.
    hairline = u(1.2)
    ImageDraw.Draw(icon).rounded_rectangle(
        [
            hairline // 2,
            hairline // 2,
            SIZE - 1 - hairline // 2,
            SIZE - 1 - hairline // 2,
        ],
        radius=u(22),
        outline=(79, 209, 197, 70),
        width=hairline,
    )

    # --- battery cell ----------------------------------------------------
    # Drawn as a mask so the teal can carry a gradient of its own.
    cell = Image.new("L", (SIZE, SIZE), 0)
    pen = ImageDraw.Draw(cell)
    pen.rounded_rectangle([u(43), u(17), u(57), u(24)], radius=u(2.5), fill=255)
    pen.rounded_rectangle(
        [u(33), u(24), u(67), u(85)],
        radius=u(9),
        outline=255,
        width=u(6),
    )
    icon.paste(vertical_gradient(SIZE, TEAL, TEAL_DEEP), (0, 0), cell)

    # --- charge level ----------------------------------------------------
    # A filled lower portion, so the mark reads as a battery even at 32px.
    # It has to sit flush against the inner wall of the shell -- the shell is
    # stroked on its path, so the cavity runs from 36 to 64 -- otherwise it
    # floats in the middle and stops reading as a level.
    level = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(level).rounded_rectangle(
        [u(37), u(46), u(63), u(81)], radius=u(5), fill=255
    )
    icon.paste(vertical_gradient(SIZE, TEAL, TEAL_DEEP), (0, 0), level)

    # --- bolt ------------------------------------------------------------
    # Knocked through the cell in the badge colour, which reads on both a
    # light and a dark background.
    bolt = [
        (56, 33),
        (39, 60),
        (48, 60),
        (44, 79),
        (61, 52),
        (52, 52),
    ]
    ImageDraw.Draw(icon).polygon([(u(x), u(y)) for x, y in bolt], fill=BOLT)

    return icon


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "custom_components/x120x/brand")
    out.mkdir(parents=True, exist_ok=True)

    icon = build()
    for name, size in (("icon.png", 256), ("icon@2x.png", 512)):
        icon.resize((size, size), Image.LANCZOS).save(out / name, "PNG", optimize=True)
        print(f"wrote {out / name} ({size}x{size})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
