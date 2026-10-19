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

  // ARQ retry driver
  setInterval(() => link.tick(), 300);
}

function addEvent(log: HTMLOListElement, text: string): void {
  const li = document.createElement("li");
  li.textContent = text;
  log.appendChild(li);
}
