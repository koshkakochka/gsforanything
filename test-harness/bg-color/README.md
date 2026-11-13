# Environment tab — Select Color bar

The Background Color section is a single wide bar showing the active color
and the text "Select Color". Clicking it opens the native color picker (the
same control the old left-hand square used). The hue, saturation and
brightness sliders under it are gone.

```
BASE=https://localhost:3588 SHOT_DIR=/workspace/gs-bg-color-shots node test.mjs
```

Covers desktop (1280×800) and a 390×844 phone: no leftover sliders, no
left-hand square, the bar keeps its label and contrast, a click hits the
color input, setting a color updates the bar and the scene background, and
a VR-menu-style forwarded click still lands on that input.
