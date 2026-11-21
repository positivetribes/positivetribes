"""Prepare a human voiceover: convert, split/trim, then compute scene timings so every line fits.

Input (either layout), in vo/mine/:
  all.<ext>                      one take, 7 lines, >= ~1.2 s of silence between lines
  l1.<ext> ... l7.<ext>          one file per line
<ext> = m4a, mp3, wav, aiff, caf (anything afconvert reads; Voice Memos .m4a works).
Output: vo/final/l1..l7.wav (trimmed, mono 44.1k) and timings.json (read by render.mjs and mix.py).
Falls back to the synthetic Zoe lines in vo/ for any line that has no recording."""
import glob, json, math, os, struct, subprocess, sys, wave

SR = 44100
SRC = "vo/mine"; OUT = "vo/final"
os.makedirs(OUT, exist_ok=True)

# design (original) scene windows, and the lead-in before the voice starts in each scene
DESIGN = [(0, 5.4), (5.4, 12.8), (12.8, 17.6), (17.6, 24.8), (24.8, 33.8), (33.8, 41.2), (41.2, 48.4)]
LEAD = [1.2, 0.8, 0.7, 1.0, 1.0, 0.8, 0.8]
TAIL = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.8]

def convert(src, dst):
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@%d" % SR, "-c", "1", src, dst], check=True)

def read(path):
    # parse RIFF chunks directly: afconvert may write WAVE_FORMAT_EXTENSIBLE, which `wave` rejects
    b = open(path, "rb").read(); p = 12; raw = b""
    while p + 8 <= len(b):
        cid, size = b[p:p + 4], struct.unpack("<I", b[p + 4:p + 8])[0]
        if cid == b"data":
            raw = b[p + 8:p + 8 + size] if size != 0xFFFFFFFF else b[p + 8:]; break
        p += 8 + size + (size & 1)
    raw = raw[:len(raw) // 2 * 2]
    return [s / 32768 for s in struct.unpack("<%dh" % (len(raw) // 2), raw)]

def write(path, x):
    peak = max(abs(v) for v in x) or 1
    g = min(0.9 / peak, 8.0)
    w = wave.open(path, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(struct.pack("<%dh" % len(x), *[int(max(-1, min(1, v * g)) * 32767) for v in x])); w.close()

def frames_rms(x, ms=20):
    n = int(SR * ms / 1000)
    return [math.sqrt(sum(v * v for v in x[i:i + n]) / n) for i in range(0, len(x) - n, n)], n

def active_spans(x, min_gap=1.0, min_len=0.4):
    r, n = frames_rms(x)
    srt = sorted(r); loud = srt[int(len(srt) * 0.95)] or 0.01
    thr = max(0.004, loud * 0.06)
    fps = SR / n
    spans, start, quiet = [], None, 0
    for i, v in enumerate(r):
        if v >= thr:
            if start is None: start = i
            quiet = 0
        elif start is not None:
            quiet += 1
            if quiet / fps >= min_gap:
                spans.append((start, i - quiet + 1)); start = None; quiet = 0
    if start is not None: spans.append((start, len(r)))
    pad = int(0.12 * SR)
    return [(max(0, a * n - pad), min(len(x), b * n + pad)) for a, b in spans if (b - a) / fps >= min_len]

def find(stem):
    for p in glob.glob(f"{SRC}/{stem}.*"): return p

lines = {}
allp = find("all")
if allp:
    convert(allp, "vo/_all.wav")
    x = read("vo/_all.wav"); spans = active_spans(x, min_gap=0.5)
    while len(spans) > 7:   # a long pause inside a line: merge across the smallest gap
        k = min(range(len(spans) - 1), key=lambda j: spans[j + 1][0] - spans[j][1])
        spans[k:k + 2] = [(spans[k][0], spans[k + 1][1])]
    if len(spans) != 7:
        sys.exit(f"all.* split into {len(spans)} segments, expected 7. Leave ~2 s of silence between lines, "
                 f"or record each line as its own file (l1..l7).")
    for i, (a, b) in enumerate(spans, 1): lines[i] = x[a:b]
for i in range(1, 8):
    p = find(f"l{i}")
    if p:
        convert(p, f"vo/_l{i}.wav"); x = read(f"vo/_l{i}.wav")
        s = active_spans(x, min_gap=99, min_len=0.2)
        lines[i] = x[s[0][0]:s[-1][1]] if s else x

durs, source = [], []
for i in range(1, 8):
    if i in lines:
        write(f"{OUT}/l{i}.wav", lines[i]); source.append("you")
    else:
        os.system(f"cp vo/l{i}.wav {OUT}/l{i}.wav"); source.append("Zoe")
    w = wave.open(f"{OUT}/l{i}.wav"); durs.append(w.getnframes() / w.getframerate())

warp, vo, t = [], [], 0.0
for i, ((d0, d1), lead, tail, d) in enumerate(zip(DESIGN, LEAD, TAIL, durs), 1):
    length = max(d1 - d0, lead + d + tail)
    warp.append([d0, d1, round(t, 3), round(t + length, 3)])
    vo.append([round(t + lead, 3), f"{OUT}/l{i}.wav"])
    t += length
json.dump({"warp": warp, "total": round(t, 3), "vo": vo}, open("timings.json", "w"), indent=1)
print("line  source  seconds  scene")
for i, (s, d, w) in enumerate(zip(source, durs, warp), 1):
    print(f" {i}    {s:5}  {d:6.2f}   {w[2]:.1f}-{w[3]:.1f}")
print("total", round(t, 1), "s")
