export interface UiLink {
  send: (payload: Uint8Array) => void;
  start: (onReceive: (payload: Uint8Array, seq: number) => void) => Promise<void>;
  stop: () => void;
  tick: () => void;
  sampleRate: number;
  resume?: () => Promise<void>;
  state?: string;
  setBaseHz?: (hz: number) => void;
  getBaseHz?: () => number;
  beep?: (freq?: number, durationMs?: number) => void;
  analyser?: AnalyserNode;
  busy?: boolean;
  onTxStart?: (durationMs: number) => void;
  onTxEnd?: () => void;
  onAck?: (seq: number) => void;
  onDebug?: (msg: string) => void;
}

export function buildUi(root: HTMLElement, link: UiLink): void {
  const currentHz = link.getBaseHz ? link.getBaseHz() : 2000;
  root.innerHTML = `
    <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 1rem;">
      <h1 style="margin-bottom: 0.5rem;">WaveLink</h1>
      <p style="color: #666; font-size: 0.9rem; margin-top: 0;">Acoustic peer-to-peer data modem</p>

      <div style="margin-bottom: 1rem; padding: 0.75rem; background: #f3f4f6; border-radius: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
          <p data-testid="band-badge" style="margin: 0; font-weight: bold;">band: ${currentHz} Hz</p>
          <button data-testid="audio-enable-btn" style="padding: 0.25rem 0.5rem; font-size: 0.85rem; cursor: pointer;">Enable Audio / Mic</button>
        </div>
        <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
          <span style="font-size: 0.85rem; color: #555;">Set band:</span>
          <button data-testid="band-2000" style="padding: 0.25rem 0.5rem; cursor: pointer;">2000 Hz (Audible)</button>
          <button data-testid="band-14500" style="padding: 0.25rem 0.5rem; cursor: pointer;">14500 Hz (High)</button>
          <button data-testid="band-18500" style="padding: 0.25rem 0.5rem; cursor: pointer;">18500 Hz (Ultrasound)</button>
          <button data-testid="test-speaker-btn" style="padding: 0.25rem 0.5rem; cursor: pointer; margin-left: auto;">Test Beep</button>
        </div>
      </div>

      <div style="display: flex; gap: 0.5rem; margin-bottom: 0.5rem;">
        <input data-testid="send-input" placeholder="message to send over air" style="flex: 1; padding: 0.5rem; font-size: 1rem;" />
        <button data-testid="send-btn" style="padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; background: #2563eb; color: white; border: none; border-radius: 4px;">Send</button>
      </div>

      <div data-testid="tx-status-bar" style="display: none; margin-bottom: 1rem; padding: 0.65rem 0.85rem; border-radius: 8px; font-size: 0.88rem; background: #fef3c7; border: 1px solid #fde68a; color: #92400e;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
          <span data-testid="tx-status-text" style="font-weight: 600;">🔊 Transmitting over speaker...</span>
          <span data-testid="tx-timer" style="font-variant-numeric: tabular-nums; font-weight: bold;">0.0s</span>
        </div>
        <div style="width: 100%; height: 6px; background: rgba(0,0,0,0.08); border-radius: 3px; overflow: hidden;">
          <div data-testid="tx-progress" style="height: 100%; width: 0%; background: #d97706; transition: width 0.1s linear;"></div>
        </div>
      </div>

      <div style="margin-bottom: 1rem;">
        <label style="font-weight: bold; font-size: 0.9rem;">Received Messages:</label>
        <pre data-testid="receive-pane" style="background: #1e1e1e; color: #4ade80; padding: 1rem; border-radius: 6px; min-height: 80px; white-space: pre-wrap; word-break: break-all; margin-top: 0.25rem;"></pre>
      </div>

      <div style="margin-bottom: 1rem;">
        <canvas data-testid="spectrogram" style="width: 100%; height: 120px; background: #000; border-radius: 6px; display: block;"></canvas>
      </div>

      <div>
        <label style="font-weight: bold; font-size: 0.85rem; color: #666;">Activity Log:</label>
        <ol data-testid="event-log" style="font-size: 0.85rem; color: #444; max-height: 150px; overflow-y: auto; padding-left: 1.25rem; margin-top: 0.25rem;"></ol>
      </div>
    </div>
  `;
  const input = root.querySelector<HTMLInputElement>("[data-testid=send-input]")!;
  const btn = root.querySelector<HTMLButtonElement>("[data-testid=send-btn]")!;
  const pane = root.querySelector<HTMLPreElement>("[data-testid=receive-pane]")!;
  const log = root.querySelector<HTMLOListElement>("[data-testid=event-log]")!;
  const badge = root.querySelector<HTMLParagraphElement>("[data-testid=band-badge]")!;
  const enableBtn = root.querySelector<HTMLButtonElement>("[data-testid=audio-enable-btn]")!;
  const testSpeakerBtn = root.querySelector<HTMLButtonElement>("[data-testid=test-speaker-btn]")!;

  const activateAudio = () => {
    void link.resume?.();
    if (enableBtn) enableBtn.textContent = "Audio Active";
  };
  root.addEventListener("click", activateAudio);
  enableBtn?.addEventListener("click", activateAudio);

  testSpeakerBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    link.beep?.(1000, 250);
    addEvent(log, "played test beep (1000 Hz)");
  });

  const setBand = (hz: number) => {
    link.setBaseHz?.(hz);
    badge.textContent = `band: ${hz} Hz`;
    addEvent(log, `switched band to ${hz} Hz`);
  };

  root.querySelector("[data-testid=band-2000]")?.addEventListener("click", (e) => { e.stopPropagation(); setBand(2000); });
  root.querySelector("[data-testid=band-14500]")?.addEventListener("click", (e) => { e.stopPropagation(); setBand(14500); });
  root.querySelector("[data-testid=band-18500]")?.addEventListener("click", (e) => { e.stopPropagation(); setBand(18500); });

  const txBar = root.querySelector<HTMLDivElement>("[data-testid=tx-status-bar]")!;
  const txText = root.querySelector<HTMLSpanElement>("[data-testid=tx-status-text]")!;
  const txTimer = root.querySelector<HTMLSpanElement>("[data-testid=tx-timer]")!;
  const txProgress = root.querySelector<HTMLDivElement>("[data-testid=tx-progress]")!;

  let txTimerHandle: ReturnType<typeof setInterval> | null = null;

  const setTxState = (state: "idle" | "transmitting" | "sent" | "awaiting-ack" | "ack-received", durationMs = 0) => {
    if (txTimerHandle) {
      clearInterval(txTimerHandle);
      txTimerHandle = null;
    }
    if (state === "transmitting") {
      txBar.style.display = "block";
      txBar.style.background = "#fef3c7";
      txBar.style.borderColor = "#fde68a";
      txBar.style.color = "#92400e";
      txProgress.style.background = "#d97706";
      txProgress.style.width = "0%";
      txText.textContent = "🔊 Transmitting over speaker...";
      btn.disabled = true;
      btn.textContent = "Transmitting...";
      btn.style.opacity = "0.6";

      const start = Date.now();
      const end = start + durationMs;
      txTimerHandle = setInterval(() => {
        const now = Date.now();
        const remaining = Math.max(0, (end - now) / 1000);
        const pct = Math.min(100, Math.max(0, ((now - start) / durationMs) * 100));
        txTimer.textContent = `${remaining.toFixed(1)}s`;
        txProgress.style.width = `${pct.toFixed(1)}%`;
        if (now >= end) {
          if (txTimerHandle) clearInterval(txTimerHandle);
          txTimerHandle = null;
        }
      }, 50);
    } else if (state === "sent" || state === "ack-received") {
      txBar.style.display = "block";
      txBar.style.background = "#dcfce7";
      txBar.style.borderColor = "#bbf7d0";
      txBar.style.color = "#166534";
      txProgress.style.background = "#16a34a";
      txProgress.style.width = "100%";
      txText.textContent = "✓ Sent! Ready for next message.";
      txTimer.textContent = "ready";
      btn.disabled = false;
      btn.textContent = "Send";
      btn.style.opacity = "1";
      setTimeout(() => {
        if (!link.busy) {
          txBar.style.display = "none";
        }
      }, 1500);
    } else if (state === "awaiting-ack") {
      txBar.style.display = "block";
      txBar.style.background = "#e0f2fe";
      txBar.style.borderColor = "#bae6fd";
      txBar.style.color = "#0369a1";
      txProgress.style.background = "#0284c7";
      txProgress.style.width = "100%";
      txText.textContent = "⏳ Waiting for receiver ACK...";
      txTimer.textContent = "listening";
      btn.disabled = true;
      btn.textContent = "Awaiting ACK...";
      btn.style.opacity = "0.7";
    } else {
      txBar.style.display = "none";
      btn.disabled = false;
      btn.textContent = "Send";
      btn.style.opacity = "1";
    }
  };

  link.onTxStart = (durationMs) => setTxState("transmitting", durationMs);
  link.onTxEnd = () => {
    setTxState("sent");
    addEvent(log, "transmission complete (channel ready)");
  };
  link.onAck = (seq) => {
    setTxState("sent");
    addEvent(log, `✓ ACK confirmed for seq ${seq}`);
  };
  link.onDebug = (msg) => {
    addEvent(log, `📡 ${msg}`);
  };

  btn.addEventListener("click", () => {
    const val = input.value;
    if (!val) return;
    link.send(new TextEncoder().encode(val));
    addEvent(log, `sending: "${val}" (${val.length} bytes)`);
    input.value = "";
  });

  link.start((payload, seq) => {
    const text = new TextDecoder().decode(payload);
    pane.textContent += `${text}\n`;
    addEvent(log, `received [seq ${seq}]: "${text}"`);
  });

  // Receive-path debugging: show mic level + detected preamble count so dead
  // links are diagnosable live on the device.
  const status = document.createElement("p");
  status.setAttribute("data-testid", "rx-status");
  status.style.fontSize = "0.8rem";
  status.style.color = "#666";
  root.appendChild(status);
  let micChunks = 0;
  let lastLevel = 0;
  const probe = (link as unknown as { onMicSamples?: (s: Float32Array) => void }).onMicSamples;
  if (probe) {
    const wrapped = (s: Float32Array) => {
      micChunks++;
      let peak = 0;
      for (let i = 0; i < s.length; i += 8) peak = Math.max(peak, Math.abs(s[i]!));
      lastLevel = peak;
      probe.call(link, s);
    };
    (link as unknown as { onMicSamples: (s: Float32Array) => void }).onMicSamples = wrapped;
  }
  setInterval(() => {
    const stateStr = (link as { state?: string }).state ?? "active";
    status.textContent = `mic chunks: ${micChunks} · peak: ${lastLevel.toFixed(4)} · status: ${stateStr}`;
  }, 500);

  // Waterfall: draws the mic spectrum so dead links are visible — you can SEE
  // whether the peer's tones arrive and in which band.
  const canvas = root.querySelector<HTMLCanvasElement>("[data-testid=spectrogram]")!;
  canvas.width = 512; canvas.height = 160;
  const g2d = canvas.getContext ? canvas.getContext("2d") : null;
  if (g2d) {
    let bins: Uint8Array | null = null;
    let x = 0;
    const draw = () => {
      const analyser = (link as unknown as { analyser?: AnalyserNode }).analyser;
      if (!analyser) return;
      if (!bins || bins.length !== analyser.frequencyBinCount) {
        bins = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(bins);
      // image scrolls left: draw newest column at right edge
      g2d.drawImage(canvas, -2, 0);
      g2d.fillStyle = "#000";
      g2d.fillRect(canvas.width - 2, 0, 2, canvas.height);
      const n = bins.length;
      for (let y = 0; y < canvas.height; y++) {
        // log-ish freq axis: top = 24 kHz, bottom = 0
        const bin = Math.floor(((canvas.height - y) / canvas.height) * n);
        const v = bins[bin] ?? 0;
        g2d.fillStyle = v > 180 ? "#4ade80" : v > 100 ? "#3b82f6" : v > 40 ? "#1e3a8a" : "#000";
        g2d.fillRect(canvas.width - 2, y, 2, 1);
      }
      x = (x + 2) % canvas.width;
    };
    setInterval(draw, 100);
  }

  // ARQ retry driver
  setInterval(() => link.tick(), 300);
}

function addEvent(log: HTMLOListElement, text: string): void {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()} - ${text}`;
  log.prepend(li);
  while (log.children.length > 50) {
    log.removeChild(log.lastChild!);
  }
}
