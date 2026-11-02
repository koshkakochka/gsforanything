# Generates the synthetic fixtures (noise.wav, continuous.wav) next to the
# committed speech clips. speech.wav: 2 s silence, a TTS voice saying "Add a
# red cube next to the tree", 4 s silence (16 kHz mono). speech-noisy.wav: the
# same plus continuous fan-like noise at RMS 0.03 (louder than the old fixed
# 0.015 VAD threshold). Chrome loops these files as the fake microphone.
import numpy as np, wave, os
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
sr = 16000
def wr(name, x):
    w = wave.open(os.path.join(D, name), 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes()); w.close()
rng = np.random.default_rng(7)
n = rng.normal(0, 1, sr * 8); n = np.convolve(n, np.ones(6) / 6, 'same'); n = n / np.sqrt((n ** 2).mean()) * 0.03
wr('noise.wav', n)  # noise only: nothing may be sent
rng = np.random.default_rng(3)
t = np.arange(sr * 20) / sr
x = rng.normal(0, 1, len(t)); x = np.convolve(x, np.ones(4) / 4, 'same')
x = x / np.sqrt((x ** 2).mean()) * 0.12 * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))
wr('continuous.wav', np.concatenate([np.zeros(sr * 2), x]))  # 20 s with no pause: must be cut at ~15 s
t = np.arange(int(sr * 1.5)) / sr
beep = np.where(t < 0.4, 0.3 * np.sin(2 * np.pi * 1000 * t), 0.0)
wr('beep.wav', np.tile(beep, 6))  # 1 kHz beeps: Whisper says "[BEEP]"/"(beeping)" — must not be sent
