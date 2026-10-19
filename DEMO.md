# WaveLink demo runbook (SW-41)

## Build + serve
1. `npm run build && node serve.mjs`
2. Note the printed LAN URL; open it on both devices (laptop + tablet) over the same hotspot.

## Pre-demo checklist
- [ ] Volume 80% on the sender; media volume, not system.
- [ ] Devices 20–40 cm apart, speakers/mics facing each other.
- [ ] Both browsers granted mic permission (required only on the receiver side and sender if bidirectional).
- [ ] Calibration run on the receiver; band badge shows the chosen tier.
- [ ] Fallback ready: if near-silent bands fail, audible mode (2 kHz) is guaranteed to work.

## Demo script (5 min)
1. **The hook**: type a message on the laptop, hit Send. Tablet shows it appear — audience heard nothing. Spectrogram shows the ultrasonic burst.
2. **The noise test**: judge plays music on a phone. Send again. CRC + ARQ visibly repair chunks in the event log; message still arrives.
3. **The explain**: switch to audible band — the audience now *hears* the data as chirps. "That's what your Wi-Fi would sound like."
4. **Q&A ammo**: 40 bps raw — deliberate trade for reliability; roadmap shows OFDM subcarriers for 10× throughput.

## Known failure modes
- Cheap laptop speakers can't emit >16 kHz: calibration auto-falls to near-audible or audible tier.
- Browser mic processing re-enabled (permission prompt default): verify badge shows a band; if link is dead, re-check `echoCancellation:false` in console.
- ACK tone unheard → sender retries up to 5×; event log shows retries.
