# SW-41 Acoustic Data Link — Design

## Intent & why
Send data between two devices using sound (speaker → microphone) instead of Wi-Fi/Bluetooth.
Hackathon: Bits2Wave (SW-41). 24h build on Nov 22; PPT selection round by Oct 30.
Winning angle: "almost silent + best possible transfer quality even in noisy conditions" —
near-inaudible ultrasonic-capable link with strong noise robustness and a live, tangible demo.

## Goals
- Point-to-point text/file transfer between two devices via audio, no network.
- Near-silent operation: default band centered in ultrasonic range (~18–20 kHz), audible fallback mode for cheap speakers.
- Robust in noisy conditions: multi-tone OFDM-style parallel symbol carriers + per-chunk CRC + FEC + automatic retransmission (ARQ).
- Live demo works in a hackathon hall (crowd noise, phone mics).
- Self-noise handled: receiver AGC + bandpass filtering; transmitter gain ramping to avoid clock/AGC artifacts.

## Non-goals / anti-goals
- No real network stack features (routing, many-to-many). Point-to-point only.
- No production-grade encryption (maybe simple XOR/AES as demo garnish, not core).
- Not aiming for >1 kbps; reliability and wow-factor beat raw speed.
- Anti-goal: a demo that only works in a quiet room.

## Constraints
- Team of 4, all CSE, strong PyTorch/ML + full-stack; 2 pitchers.
- Hardware available: laptops, an Android phone, ESP32s + ESP32-S3 with 1.43" round LCD (optional prop).
- Windows dev machines. Must run offline at demo (no cloud dependency).
- 24h build — every task must be independently demoable.

## How (decided)
- Modulation: OFDM-style multi-carrier FSK/QAM-ish tones across ~17.5–20.5 kHz, chirp preamble for sync (RADAR-style correlation sync is the key robustness trick).
- Symbol rate conservative (~10–20 symbols/sec), 64–256 byte packets, CRC-16, simple repetition or Hamming FEC, stop-and-wait ARQ.
- Core in Python (NumPy/SciPy + sounddevice) — cross-platform, testable laptop-to-laptop and laptop-to-phone.
- Companion Android receiver app optional stretch (Android AudioRecord + same DSP in Kotlin/JNI or via pre-recorded PCM).
- ESP32 round LCD used only as a demo prop showing "bytes received" ticker if time permits — never on the critical path.
- Demo dashboard: web UI showing live waterfall/spectrogram, packets, throughput, noise injection toggle.

## What's left to the builder
- Exact tone plan, preamble design, gain levels, AGC thresholds.
- UI layout, demo script details.
- Whether phone app happens (stretch).

## Demo story (for judges)
1. Two laptops (or laptop + phone) face each other; audience sees live spectrogram.
2. Send a message/file near-silently — audience hears nothing, screen shows bytes flowing.
3. Judge plays music/noise from phone — link still delivers (CRC + FEC + ARQ visibly repairing chunks).
4. Switch to audible mode for the "aha" — you literally hear the data as chirps.

## Amendments (builder-review calls, dated 2026-10-19)
- **Three-tier band fallback instead of one ultrasonic band** (builder call):
  1. `ultrasonic` 18.5–20.5 kHz — true silent mode, if the speaker passes characterization.
  2. `near-audible` 14.5–17 kHz — "silent to most adults" (faint hiss for the young); default when ultrasonic fails.
  3. `audible` 1–4 kHz — guaranteed fallback; also the dramatic "hear the data" demo mode.
- **Device characterization step** at first launch: play a short calibration sweep, measure mic-side response, auto-pick the best band. Doubles as a demo moment ("the link tunes itself to this room").
- **Windows/phone audio processing must be disabled**: WASAPI exclusive or raw mode in sounddevice; disable mic AGC/noise-suppression/echo-cancellation (these destroy ultrasonic content). Documented setup step, checked in a pre-demo checklist.
- **Hall-noise argument is real**: crowd/music noise is mostly <10 kHz, so the 14–20 kHz band is naturally protected — this is the pitch line for "works in noise."
- Sim-first development: the whole modem must work in a file/virtual-cable simulation (numpy arrays in, noise added, decode out) before any real audio. Protects the 24h clock.

## Architecture change (2026-10-19, user decision)
**Browser-first.** The modem is TypeScript in the browser (Web Audio API + FFT), served from one static web app. Demo setup: laptop hosts the page over a phone hotspot / local network; second device (tablet) opens the same URL. No Python audio path at all — Python/PyTorch effort goes into the optional ML denoiser and the dashboard only if time permits.

Rationale:
- `getUserMedia({ echoCancellation: false, noiseSuppression: false, autoGainControl: false })` disables the OS audio processing that destroys ultrasonic content — deterministic, cross-platform.
- Web Audio gives precise scheduling (AudioContext clocks), native FFT (AnalyserNode), and works identically on Windows laptop and Android tablet.
- Served page = zero install on the second device; QR code to open it is a demo moment.
- 48 kHz sample rate (request explicitly; Chrome/Android default) gives Nyquist at 24 kHz — the 18.5–20.5 kHz band is inside it.
- Fallback if a device can't do ultrasonic: same page supports the three-band tiers; calibration sweep picks one automatically.

Non-goal retained: no server-side logic beyond static file serving + a tiny WebSocket (optional) for the dashboard mirror. The acoustic path is always device-to-device over air, never over the network.

## Final constraints (user answers, 2026-10-19)
- Demo pairing: laptop speaker/mic ↔ tablet (second device opens the hosted web page over local network/hotspot). Laptop↔laptop kept as dev-mode convenience.
- ML stretch: only if the working link is stable — an on-device denoiser (light model on the spectrogram) to boost SNR, pitched as "the AI layer" for judges. Never on the critical path.
