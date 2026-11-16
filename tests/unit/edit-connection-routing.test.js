// @vitest-environment happy-dom
// Edit Connection dialog: the upstream-routing fields show only for providers with the
// providerRouting quirk, load what is stored, save it back as a validated object, and
// block saving (with an inline error) instead of silently dropping an invalid entry.
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
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const dialog = () => document.querySelector("[role=dialog]");
const field = (placeholder) => dialog().querySelector(`input[placeholder="${placeholder}"]`);
const fallbackSwitch = () => dialog().querySelector('[role=switch][aria-label="Fall back to other providers"]');
// Primary buttons end in an icon glyph, so match on the leading label text.
const button = (text) => [...dialog().querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(text));

// React tracks the input's value through the prototype setter; assigning `value`
// directly would not fire onChange. Reflect.set with a receiver runs that setter on `input`.
async function type(input, value) {
  await act(async () => {
    Reflect.set(window.HTMLInputElement.prototype, "value", value, input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el) {
  await act(async () => el.click());
}

async function openDialog(connection) {
  const onSave = vi.fn(async () => {});
  await act(async () =>
    root.render(h(EditConnectionModal, { isOpen: true, connection, proxyPools: [], onSave, onClose: () => {} })),
  );
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
    const onSave = await openDialog(openrouter({ providerRouting: { only: ["anthropic"], allow_fallbacks: false } }));
    expect(field("google-vertex/global").value).toBe("anthropic");
    expect(fallbackSwitch().getAttribute("aria-checked")).toBe("false");

    await type(field("google-vertex/global"), "Google-Vertex/Global, google-vertex/global");
    await type(field("anthropic, google-vertex"), "anthropic");
    await type(field("amazon-bedrock"), "amazon-bedrock");
    await click(fallbackSwitch());
    await click(button("Save"));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].providerRouting).toEqual({
      only: ["google-vertex/global"],
      order: ["anthropic"],
      ignore: ["amazon-bedrock"],
    });
  });

  it("shows an inline error and blocks saving for an invalid entry", async () => {
    const onSave = await openDialog(openrouter({ providerRouting: { only: ["google-vertex/global"] } }));
    await type(field("google-vertex/global"), "google vertex, google-vertex/global/x");
    expect(dialog().textContent).toContain("Not a provider slug: google vertex, google-vertex/global/x");
    expect(button("Save").disabled).toBe(true);
    await click(button("Save"));
    expect(onSave).not.toHaveBeenCalled();

    await type(field("google-vertex/global"), "google-vertex/global");
    expect(dialog().textContent).not.toContain("Not a provider slug");
    expect(button("Save").disabled).toBe(false);
  });

  it("clears the setting when every field is emptied", async () => {
    const onSave = await openDialog(openrouter({ providerRouting: { only: ["anthropic"] } }));
    await type(field("google-vertex/global"), "");
    await click(button("Save"));
    expect(onSave.mock.calls[0][0].providerRouting).toBeNull();
  });

  it("starts empty with fallbacks on when nothing is stored", async () => {
    await openDialog(openrouter(undefined));
    expect(field("google-vertex/global").value).toBe("");
    expect(fallbackSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("is absent for providers without the quirk", async () => {
    const onSave = await openDialog({ ...openrouter(undefined), provider: "openai" });
    expect(field("google-vertex/global")).toBeNull();
    await click(button("Save"));
    expect(onSave.mock.calls[0][0]).not.toHaveProperty("providerRouting");
  });
});
