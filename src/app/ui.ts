export interface UiLink {
  send: (payload: Uint8Array) => void;
  start: (onReceive: (payload: Uint8Array, seq: number) => void) => Promise<void>;
  stop: () => void;
  tick: () => void;
  sampleRate: number;
}

export function buildUi(root: HTMLElement, link: UiLink): void {
  root.innerHTML = `
    <h1>WaveLink</h1>
    <p data-testid="band-badge">band: —</p>
    <input data-testid="send-input" placeholder="message to send over air" />
    <button data-testid="send-btn">Send</button>
    <pre data-testid="receive-pane"></pre>
    <canvas data-testid="spectrogram"></canvas>
    <ol data-testid="event-log"></ol>
  `;
  const input = root.querySelector<HTMLInputElement>("[data-testid=send-input]")!;
  const btn = root.querySelector<HTMLButtonElement>("[data-testid=send-btn]")!;
  const pane = root.querySelector<HTMLPreElement>("[data-testid=receive-pane]")!;
  const log = root.querySelector<HTMLOListElement>("[data-testid=event-log]")!;

  btn.addEventListener("click", () => {
    link.send(new TextEncoder().encode(input.value));
    addEvent(log, `sent ${input.value.length} bytes`);
  });

  link.start((payload) => {
    pane.textContent += new TextDecoder().decode(payload);
  });

  // Receive-path debugging: show mic level + detected preamble count so dead
  // links are diagnosable live on the device.
  const status = document.createElement("p");
  status.setAttribute("data-testid", "rx-status");
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
    status.textContent = `mic chunks: ${micChunks} · last peak: ${lastLevel.toFixed(4)}`;
  }, 500);

  // ARQ retry driver
  setInterval(() => link.tick(), 300);
}

function addEvent(log: HTMLOListElement, text: string): void {
  const li = document.createElement("li");
  li.textContent = text;
  log.appendChild(li);
}
