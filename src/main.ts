import { AudioLink } from "./audio/link";
import { setBaseHz } from "./dsp/protocol";
import { buildUi, type UiLink } from "./app/ui";

function boot() {
  const root = document.getElementById("app")!;

  // Default to universally supported 2000 Hz audible band on both devices so
  // communication works immediately without hardware filtering issues.
  setBaseHz(2000);
  const link = new AudioLink(2000);
  buildUi(root, link as unknown as UiLink);
}

boot();
