"""Writes small equirect Radiance .hdr test skies: make-hdr.py out.hdr [sunset|teal]."""
import math, struct, sys
out, style = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else 'sunset')
W, H = 512, 256
def rgbe(r, g, b):
    m = max(r, g, b)
    if m < 1e-32: return b'\0\0\0\0'
    e = math.frexp(m)[1]; s = 256.0 / (2 ** e) * 0.9999
    return bytes([int(r * s), int(g * s), int(b * s), e + 128])
rows = []
for y in range(H):
    v = y / (H - 1)  # 0 top .. 1 bottom
    row = bytearray()
    for x in range(W):
        u = x / W
        if style == 'teal':
            sky = (0.05, 0.6 - 0.4 * v, 0.55) if v < 0.5 else (0.25, 0.2, 0.12)
            stripe = 1.0 + 3.0 * (abs(math.sin(u * math.pi * 8)) > 0.97)
            r, g, b = (c * stripe for c in sky)
        else:
            if v < 0.5:
                t = v / 0.5
                r, g, b = 0.08 + 1.6 * t ** 3, 0.12 + 0.7 * t ** 3, 0.45 - 0.3 * t
            else:
                r, g, b = 0.18, 0.12, 0.08
            d = math.hypot((u - 0.5) * 2 * math.pi, (v - 0.44) * math.pi)
            if d < 0.12: r, g, b = 60.0, 45.0, 25.0
            elif d < 0.4: k = (0.4 - d) / 0.28 * 2.0; r += k; g += k * 0.6; b += k * 0.2
        row += rgbe(r, g, b)
    rows.append(bytes(row))
with open(out, 'wb') as f:
    f.write(b'#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n' + f'-Y {H} +X {W}\n'.encode())
    for r in rows: f.write(r)
