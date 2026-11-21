"""Synthesize an original ambient music bed, duck it under the narration, and mix to a stereo WAV.
Pure standard library: no downloads, no third-party audio, no licensing questions."""
import array, math, random, struct, sys, wave

import json, os
SR = 44100
TOTAL = 50.8
VO = [(1.2, "vo/l1.wav"), (6.2, "vo/l2.wav"), (14.4, "vo/l3.wav"), (19.4, "vo/l4.wav"),
      (26.6, "vo/l5.wav"), (35.4, "vo/l6.wav"), (44.2, "vo/l7.wav")]
if os.path.exists("timings.json"):   # written by prep_vo.py; overrides the Zoe defaults above
    _t = json.load(open("timings.json")); TOTAL = _t["total"]; VO = [tuple(v) for v in _t["vo"]]
N = int(TOTAL * SR)

def read_mono(path):
    w = wave.open(path)
    raw = w.readframes(w.getnframes())
    return [s / 32768 for s in struct.unpack("<%dh" % (len(raw) // 2), raw)]

# ---- narration track, normalized
voice = [0.0] * N
for start, path in VO:
    x = read_mono(path)
    peak = max(abs(v) for v in x) or 1
    g = 0.9 / peak
    o = int(start * SR)
    for i, v in enumerate(x):
        if o + i < N:
            voice[o + i] += v * g

# ---- ducking envelope: follow the voice amplitude, smooth it, music drops while speaking
win = int(0.05 * SR)
env = [0.0] * N
acc = 0.0
att, rel = 1 - math.exp(-1 / (0.04 * SR)), 1 - math.exp(-1 / (0.45 * SR))
for i in range(N):
    a = abs(voice[i])
    acc += (a - acc) * (att if a > acc else rel)
    env[i] = acc
duck = [1.0 - 0.58 * min(1.0, e * 9) for e in env]

# ---- music: slow pad + soft bass + gentle plucks, C - G/B - Am - F, 96 bpm
BPM = 96
beat = 60 / BPM
bar = beat * 4
hz = lambda m: 440 * 2 ** ((m - 69) / 12)
CHORDS = [  # (bass midi, chord midi notes)
    (36, [60, 64, 67, 71]),   # Cmaj7
    (35, [62, 67, 71, 74]),   # G/B
    (33, [60, 64, 69, 72]),   # Am
    (29, [60, 65, 69, 72]),   # F
]
random.seed(7)
left = [0.0] * N
right = [0.0] * N

def add_tone(freq, t0, dur, amp, attack, release, pan, harmonics=((1, 1.0), (2, 0.18), (3, 0.06)), detune=0.0):
    i0 = int(t0 * SR)
    n = int((dur + release) * SR)
    w = 2 * math.pi * freq / SR
    ph = random.random() * 6.28
    for k in range(n):
        i = i0 + k
        if i >= N:
            break
        t = k / SR
        if t < attack:
            e = t / attack
        elif t < dur:
            e = 1.0
        else:
            e = max(0.0, 1 - (t - dur) / release)
        s = 0.0
        for h, a in harmonics:
            s += a * math.sin(w * h * k + ph * h)
        if detune:
            s += 0.6 * math.sin(w * (1 + detune) * k + ph)
        s *= amp * e
        left[i] += s * (1 - pan) * 0.5 * 2 / 2
        right[i] += s * (1 + pan) * 0.5 * 2 / 2

def pluck(freq, t0, amp, pan):
    i0 = int(t0 * SR)
    n = int(1.6 * SR)
    w = 2 * math.pi * freq / SR
    for k in range(n):
        i = i0 + k
        if i >= N:
            break
        t = k / SR
        e = math.exp(-t * 3.2) * min(1.0, t / 0.004)
        s = (math.sin(w * k) + 0.25 * math.sin(2 * w * k) * math.exp(-t * 6)) * amp * e
        left[i] += s * (1 - pan) * 0.5
        right[i] += s * (1 + pan) * 0.5

nbars = int(TOTAL / bar) + 1
for b in range(nbars):
    t0 = b * bar
    bass, notes = CHORDS[b % 4]
    last = (b == nbars - 1)
    # pad: each chord tone, long attack, overlapping into the next bar
    for j, m in enumerate(notes):
        add_tone(hz(m), t0, bar + 0.35, 0.050, 0.9, 1.4, (j - 1.5) * 0.35, detune=0.003)
    add_tone(hz(bass), t0, bar + 0.1, 0.11, 0.25, 0.9, 0.0, harmonics=((1, 1.0), (2, 0.12)))
    # arpeggio pluck from bar 2 onward (leaves the opening airy)
    if b >= 2:
        pat = [0, 2, 1, 3, 2, 1, 3, 2]
        for e8, idx in enumerate(pat):
            m = notes[idx] + 12
            pluck(hz(m), t0 + e8 * beat / 2, 0.050 if e8 % 2 == 0 else 0.036, ((e8 % 4) - 1.5) * 0.3)

# ---- master: music bed gain, global fade in/out, duck, then sum with voice
FADE_IN, FADE_OUT = 1.2, 3.2
out = array.array("h", [0]) * (N * 2)
MUSIC_GAIN = 1.35
for i in range(N):
    t = i / SR
    g = min(1.0, t / FADE_IN) * min(1.0, (TOTAL - t) / FADE_OUT)
    m_l = left[i] * MUSIC_GAIN * g * duck[i]
    m_r = right[i] * MUSIC_GAIN * g * duck[i]
    v = voice[i]
    l = math.tanh(1.25 * (m_l + v * 0.95))
    r = math.tanh(1.25 * (m_r + v * 0.95))
    out[2 * i] = int(l * 30000)
    out[2 * i + 1] = int(r * 30000)

w = wave.open("mix.wav", "wb")
w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
w.writeframes(out.tobytes())
w.close()
print("mix.wav", round(N / SR, 1), "s")
