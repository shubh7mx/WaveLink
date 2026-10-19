import { AudioLink, MIC_CONSTRAINTS } from "./audio/link";
import { calibrate } from "./audio/calibration";
import { setBaseHz } from "./dsp/protocol";
import { buildUi, type UiLink } from "./app/ui";

async function boot() {
  const root = document.getElementById("app")!;
  const badge = () => root.querySelector("[data-testid=band-badge]")!;

  const link = new AudioLink(2000); // provisional; recalibrated below
  buildUi(root, link as unknown as UiLink);

  try {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...MIC_CONSTRAINTS } });
    const baseHz = await calibrate(ctx, stream);
    await ctx.close();
    stream.getTracks().forEach((t) => t.stop());
    setBaseHz(baseHz);
    badge().textContent = `band: ${baseHz} Hz`;
  } catch (err) {
    badge().textContent = `band: audible fallback (calibration failed: ${err})`;
    setBaseHz(2000);
  }
}

void boot();
