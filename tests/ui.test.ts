import { describe, expect, test, vi } from "vitest";
import { buildUi } from "../src/app/ui";

function stubLink() {
  return {
    send: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    tick: vi.fn(),
    onMicSamples: vi.fn(),
    sampleRate: 48000,
  };
}

describe("ui", () => {
  test("renders controls and send box wires to link.send", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const link = stubLink();
    buildUi(root, link as never);
    expect(root.querySelector("[data-testid=send-btn]")).toBeTruthy();
    expect(root.querySelector("[data-testid=receive-pane]")).toBeTruthy();
    expect(root.querySelector("[data-testid=band-badge]")).toBeTruthy();
    const input = root.querySelector<HTMLInputElement>("[data-testid=send-input]")!;
    input.value = "héllo";
    (root.querySelector("[data-testid=send-btn]") as HTMLButtonElement).click();
    expect(link.send).toHaveBeenCalled();
    const sent = link.send.mock.calls[0]![0] as Uint8Array;
    expect(Array.from(sent)).toEqual(Array.from(new TextEncoder().encode("héllo")));
  });

  test("visual indicator activates onTxStart and recovers onTxEnd without waiting for ACK", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const link = stubLink();
    buildUi(root, link as never);

    const btn = root.querySelector<HTMLButtonElement>("[data-testid=send-btn]")!;
    const txBar = root.querySelector<HTMLDivElement>("[data-testid=tx-status-bar]")!;
    expect(txBar.style.display).toBe("none");
    expect(btn.disabled).toBe(false);

    // Trigger transmit start callback
    (link as unknown as { onTxStart: (ms: number) => void }).onTxStart(3000);
    expect(txBar.style.display).toBe("block");
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Transmitting...");

    // Trigger transmit end (direct transmit: ready immediately without waiting for ACK)
    (link as unknown as { onTxEnd: () => void }).onTxEnd();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Send");
  });
});
