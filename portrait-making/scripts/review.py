"""Side-by-side views of the painting and the reference, for critique.

  python review.py work/still.png subject.jpg --ref-width 1335 --face 380 560 1080 1200 --out work/review

Writes <out>_full.jpg (whole painting beside the photo) and <out>_face.jpg
(the --face box, in reference units, painting beside photo at full detail).
Open these as image files, not as a small browser screenshot.
"""
import argparse

from PIL import Image


def side_by_side(a, b, height):
    a = a.resize((round(a.width * height / a.height), height), Image.LANCZOS)
    b = b.resize((round(b.width * height / b.height), height), Image.LANCZOS)
    out = Image.new("RGB", (a.width + b.width + 12, height), (30, 28, 26))
    out.paste(a, (0, 0))
    out.paste(b, (a.width + 12, 0))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("painting")
    ap.add_argument("reference")
    ap.add_argument("--ref-width", type=int, required=True)
    ap.add_argument("--face", type=int, nargs=4, metavar=("X0", "Y0", "X1", "Y1"), required=True)
    ap.add_argument("--out", default="review")
    a = ap.parse_args()

    paint = Image.open(a.painting).convert("RGB")
    photo = Image.open(a.reference).convert("RGB").resize(paint.size, Image.LANCZOS)
    side_by_side(paint, photo, 900).save(a.out + "_full.jpg", quality=90)

    k = paint.width / a.ref_width
    box = tuple(round(v * k) for v in a.face)
    side_by_side(paint.crop(box), photo.crop(box), 800).save(a.out + "_face.jpg", quality=92)
    print(a.out + "_full.jpg", a.out + "_face.jpg")


if __name__ == "__main__":
    main()
