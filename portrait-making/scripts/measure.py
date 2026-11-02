"""Gridded views of a reference photo, for measuring landmarks in reference units.

The photo is scaled to --ref-width (its height follows its proportions); grid
lines are labelled in those units, so coordinates read off the image can go
straight into subject.js.

  python measure.py photo.jpg --out work/                       # overview, grid every 100
  python measure.py photo.jpg --out work/ --crop 400 580 1000 1180 --step 50 --zoom 2
  python measure.py photo.jpg --sample cheek:520,900 hair:300,900

--sample prints the photo's average colour (9x9 patch) at named points.
"""
import argparse
import os

from PIL import Image, ImageDraw


def gridded(ref, box, step, zoom):
    x0, y0, x1, y1 = box
    view = ref.crop(box).resize((int((x1 - x0) * zoom), int((y1 - y0) * zoom)))
    d = ImageDraw.Draw(view)
    for v in range((x0 // step + 1) * step, x1 + 1, step):
        x = (v - x0) * zoom
        d.line([(x, 0), (x, view.height)], fill=(255, 0, 0) if v % (step * 2) == 0 else (0, 200, 255))
        d.text((x + 2, 2), str(v), fill=(255, 255, 0))
    for v in range((y0 // step + 1) * step, y1 + 1, step):
        y = (v - y0) * zoom
        d.line([(0, y), (view.width, y)], fill=(255, 0, 0) if v % (step * 2) == 0 else (0, 200, 255))
        d.text((2, y + 2), str(v), fill=(255, 255, 0))
    return view


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("--ref-width", type=int, default=1000)
    ap.add_argument("--out", default=".")
    ap.add_argument("--crop", type=int, nargs=4, metavar=("X0", "Y0", "X1", "Y1"))
    ap.add_argument("--step", type=int, default=100)
    ap.add_argument("--zoom", type=float, default=1.0)
    ap.add_argument("--sample", nargs="*", default=[], metavar="NAME:X,Y")
    a = ap.parse_args()

    src = Image.open(a.image).convert("RGB")
    ref_h = round(a.ref_width * src.height / src.width)
    ref = src.resize((a.ref_width, ref_h), Image.LANCZOS)
    print(f"reference space: {a.ref_width} x {ref_h}")

    if a.sample:
        for item in a.sample:
            name, xy = item.split(":")
            x, y = (int(v) for v in xy.split(","))
            px = [ref.getpixel((min(max(x + dx, 0), a.ref_width - 1), min(max(y + dy, 0), ref_h - 1)))
                  for dx in range(-4, 5) for dy in range(-4, 5)]
            avg = tuple(sum(p[i] for p in px) // len(px) for i in range(3))
            print(f"{name:>12} ({x},{y})  rgb{avg}  #{avg[0]:02x}{avg[1]:02x}{avg[2]:02x}")
        return

    os.makedirs(a.out, exist_ok=True)
    box = tuple(a.crop) if a.crop else (0, 0, a.ref_width, ref_h)
    name = "grid_full.png" if not a.crop else "grid_{}_{}_{}_{}.png".format(*box)
    path = os.path.join(a.out, name)
    gridded(ref, box, a.step, a.zoom).save(path)
    print(path)


if __name__ == "__main__":
    main()
