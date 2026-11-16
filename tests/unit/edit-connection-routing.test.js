// @vitest-environment happy-dom
// Edit Connection dialog: the upstream-routing fields show only for providers with the
// providerRouting quirk, load what is stored, and save it back as a validated object.
import { createElement as h, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const EditConnectionModal = (await import("@/shared/components/EditConnectionModal")).default;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container;
let root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const render = (el) => act(() => root.render(el));
const field = (placeholder) => document.querySelector(`[role=dialog] input[placeholder="${placeholder}"]`);
const fallbackSwitch = () => document.querySelector('[role=dialog] [role=switch][aria-label="Fall back to other providers"]');
// Primary buttons end in an icon glyph, so match on the leading label text.
const button = (text) => [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim().startsWith(text));

function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function openDialog(connection) {
  const onSave = vi.fn(async () => {});
  render(h(EditConnectionModal, { isOpen: true, connection, proxyPools: [], onSave, onClose: () => {} }));
  return onSave;
}

const openrouter = (providerSpecificData) => ({
  id: "c1",
  name: "OR",
  priority: 1,
  authType: "apikey",
  provider: "openrouter",
  providerSpecificData,
});

describe("Edit Connection upstream routing", () => {
  it("loads the stored routing and saves edits as a validated object", async () => {
    const onSave = openDialog(openrouter({ providerRouting: { only: ["anthropic"], allow_fallbacks: false } }));
    expect(field("google-vertex/global").value).toBe("anthropic");
    expect(fallbackSwitch().getAttribute("aria-checked")).toBe("false");

    type(field("google-vertex/global"), "Google-Vertex/Global, bad/slug/path, q?x=1");
    type(field("anthropic, google-vertex"), "anthropic");
    type(field("amazon-bedrock"), "amazon-bedrock");
    act(() => fallbackSwitch().click());
    await act(async () => button("Save").click());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].providerRouting).toEqual({
      only: ["google-vertex/global"],
      order: ["anthropic"],
      ignore: ["amazon-bedrock"],
    });
  });

  it("clears the setting when every field is emptied", async () => {
    const onSave = openDialog(openrouter({ providerRouting: { only: ["anthropic"] } }));
    type(field("google-vertex/global"), "");
    await act(async () => button("Save").click());
    expect(onSave.mock.calls[0][0].providerRouting).toBeNull();
  });

  it("starts empty with fallbacks on when nothing is stored", () => {
    openDialog(openrouter(undefined));
    expect(field("google-vertex/global").value).toBe("");
    expect(fallbackSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("is absent for providers without the quirk", async () => {
    const onSave = openDialog({ ...openrouter(undefined), provider: "openai" });
    expect(field("google-vertex/global")).toBeNull();
    await act(async () => button("Save").click());
    expect(onSave.mock.calls[0][0]).not.toHaveProperty("providerRouting");
  });
});
