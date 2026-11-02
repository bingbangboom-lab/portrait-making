"""Turns captured painting frames into a paced process video, optionally with music.

  python render_video.py work/frames --out portrait-process.mp4
  python render_video.py work/frames --aspect 1:1 --out square.mp4
  python render_video.py work/frames --audio "song.mp4" --save-audio song.m4a --out with-music.mp4

Pacing: each frame stays on screen in proportion to how much it changes the
painting, so the underdrawing and block-in read clearly and the fine
refinement moves quickly. The bare canvas opens the video and the finished
painting is held at the end.

Aspect presets (output size): mobile / 9:16 -> 1080x1920 (default),
4:5 -> 1080x1350, 1:1 -> 1080x1080, 16:9 -> 1920x1080, original -> frame size.
--fit fill (default) zooms and crops to fill the frame with no bars, keeping the
point --focus (fractions of width and height) in view; --fit pad letterboxes.

--dissolve N lets each frame bleed into the next over N extra frames, for styles
such as watercolour whose wet sessions each appear at once.

Audio: any audio or video file; the audio track starts at --audio-start seconds
of the source, is cut to the video's length and fades out over --fade seconds.
"""
import argparse
import glob
import os
import subprocess
import tempfile

import numpy as np
from PIL import Image

PRESETS = {
    "mobile": (1080, 1920), "9:16": (1080, 1920), "4:5": (1080, 1350),
    "1:1": (1080, 1080), "square": (1080, 1080), "16:9": (1920, 1080), "landscape": (1920, 1080),
}


def pacing(frames, target, hold, intro, underdrawing):
    small = [np.asarray(Image.open(f).convert("L").resize((135, 202)), dtype=np.float32) for f in frames]
    change = [0.0] + [float(np.abs(small[i] - small[i - 1]).mean()) for i in range(1, len(small))]
    w = np.sqrt(np.array(change) + 0.05)
    dur = np.clip(w / w.sum() * target, 1 / 30, 0.35)
    dur[0] = intro
    for i in range(1, min(underdrawing + 1, len(dur))):
        dur[i] = max(dur[i], 0.12)          # the underdrawing, line by line
    dur[-1] = hold
    return dur


def dissolve(frames, n, keep, out_dir):
    """Each change spreads in along a soft noise field, the way a wash runs out over wet paper."""
    size = Image.open(frames[0]).size
    rng = np.random.default_rng(7)
    coarse = rng.random((size[1] // 48 + 2, size[0] // 48 + 2), dtype=np.float32)
    grain = np.asarray(Image.fromarray((coarse * 255).astype(np.uint8)).resize(size, Image.BICUBIC), dtype=np.float32) / 255
    out = []

    def emit(array):
        path = os.path.join(out_dir, "f%06d.jpg" % len(out))
        Image.fromarray(array).save(path, quality=93)
        out.append(path)

    previous = None
    for index, path in enumerate(frames):
        image = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
        if previous is not None and index > keep:
            for k in range(1, n + 1):
                t = k / (n + 1)
                alpha = np.clip((t * 1.7 - grain * 0.7) / 0.3, 0, 1)[..., None]
                emit((previous * (1 - alpha) + image * alpha).astype(np.uint8))
        emit(image.astype(np.uint8))
        previous = image
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("frames_dir")
    ap.add_argument("--out", required=True)
    ap.add_argument("--aspect", default="mobile", help="mobile|9:16|4:5|1:1|16:9|original")
    ap.add_argument("--fit", choices=["fill", "pad"], default="fill")
    ap.add_argument("--focus", type=float, nargs=2, default=[0.5, 0.4], metavar=("FX", "FY"))
    ap.add_argument("--pad-colour", default="0x1b1816")
    ap.add_argument("--seconds", type=float, default=17.0, help="time spent on the painting itself")
    ap.add_argument("--hold", type=float, default=3.5, help="hold on the finished painting")
    ap.add_argument("--intro", type=float, default=0.8, help="hold on the bare canvas")
    ap.add_argument("--underdrawing-frames", type=int, default=22,
                    help="frames that show the underdrawing (one per contour + 2); kept on screen longer")
    ap.add_argument("--dissolve", type=int, default=0, metavar="N",
                    help="N in-between frames that bleed each frame into the next (watercolour: 6)")
    ap.add_argument("--audio")
    ap.add_argument("--audio-start", type=float, default=0.0)
    ap.add_argument("--fade", type=float, default=2.4)
    ap.add_argument("--save-audio", help="also write the extracted audio track here (stream copy)")
    ap.add_argument("--crf", type=int, default=18)
    a = ap.parse_args()

    frames = sorted(glob.glob(os.path.join(a.frames_dir, "f*.jpg")))
    if not frames:
        raise SystemExit("no f*.jpg frames in " + a.frames_dir)
    if a.dissolve:
        frames = dissolve(frames, a.dissolve, a.underdrawing_frames, tempfile.mkdtemp())
    fw, fh = Image.open(frames[0]).size
    dur = pacing(frames, a.seconds, a.hold, a.intro, a.underdrawing_frames)
    total = float(dur.sum())

    list_path = os.path.join(tempfile.mkdtemp(), "frames.txt")
    with open(list_path, "w") as f:
        for path, d in zip(frames, dur):
            f.write("file '%s'\nduration %.4f\n" % (os.path.abspath(path).replace("\\", "/"), d))
        f.write("file '%s'\n" % os.path.abspath(frames[-1]).replace("\\", "/"))

    if a.aspect == "original":
        ow, oh = fw - fw % 2, fh - fh % 2
        vf = f"scale={ow}:{oh}"
    else:
        ow, oh = PRESETS[a.aspect]
        if a.fit == "fill":
            fx, fy = a.focus
            vf = (f"scale={ow}:{oh}:force_original_aspect_ratio=increase:flags=lanczos,"
                  f"crop={ow}:{oh}:(iw-{ow})*{fx}:(ih-{oh})*{fy}")
        else:
            vf = (f"scale={ow}:{oh}:force_original_aspect_ratio=decrease:flags=lanczos,"
                  f"pad={ow}:{oh}:(ow-iw)/2:(oh-ih)/2:color={a.pad_colour}")
    vf += ",fps=30,format=yuv420p"

    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list_path]
    if a.audio:
        cmd += ["-ss", str(a.audio_start), "-i", a.audio, "-map", "0:v", "-map", "1:a",
                "-af", f"afade=t=out:st={max(total - a.fade, 0):.2f}:d={a.fade}",
                "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}"]
    cmd += ["-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", str(a.crf), "-movflags", "+faststart", a.out]
    subprocess.run(cmd, check=True)

    if a.audio and a.save_audio:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", a.audio, "-vn", "-c:a", "copy", a.save_audio],
                       check=True)
    print(f"{a.out}: {ow}x{oh}, {total:.1f}s, {len(frames)} frames" + (", with audio" if a.audio else ""))


if __name__ == "__main__":
    main()
