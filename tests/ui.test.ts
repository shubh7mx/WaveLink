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
});
