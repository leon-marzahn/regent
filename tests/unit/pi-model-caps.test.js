// Pi's per-model limit rows (cli-tools connect panel). PiModelCaps has no hooks,
// so it is called as a function: the returned element tree is rendered to
// markup for the option lists, and its Select onChange handlers are invoked
// directly to check what gets written back to the panel's extra state.
import { describe, it, expect, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { PiModelCaps, capsFor, PI_DEFAULT_CAPS } from "@/app/(dashboard)/dashboard/cli-tools/connect/piCaps";

function findByLabel(node, label) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByLabel(child, label);
      if (hit) return hit;
    }
    return null;
  }
  if (node.props?.["aria-label"] === label) return node;
  return findByLabel(node.props?.children, label);
}

const props = (models, extra = {}, setExtra = vi.fn()) => ({
  values: { baseUrl: "http://localhost:20128/v1", apiKey: "k", models },
  extra,
  setExtra,
  disabled: false,
});

describe("PiModelCaps", () => {
  it("renders nothing without selected models", () => {
    expect(PiModelCaps(props([]))).toBeNull();
  });

  it("renders a row per model with preset options and keeps a hand-edited value selectable", () => {
    const html = renderToStaticMarkup(
      PiModelCaps(props(["cc/a", "cc/b"], { caps: { "cc/b": { contextWindow: 1500000, maxTokens: 20000 } } })),
    );
    expect(html).toContain('aria-label="Context window for cc/a"');
    expect(html).toContain('aria-label="Max output tokens for cc/b"');
    expect(html).toContain("200k ctx");
    expect(html).toContain("1M ctx");
    expect(html).toContain("128k out");
    // Values outside the presets stay as options, sorted in.
    expect(html).toContain("1.5M ctx");
    expect(html).toContain("20k out");
    const bOut = html.slice(html.indexOf('aria-label="Max output tokens for cc/b"'));
    expect(bOut.indexOf("16k out")).toBeLessThan(bOut.indexOf("20k out"));
    expect(bOut.indexOf("20k out")).toBeLessThan(bOut.indexOf("32k out"));
    // Model without stored caps shows exactly the presets once.
    expect(html.match(/1\.5M ctx/g)).toHaveLength(1);
  });

  it("writes a changed context window for that model only, starting from the defaults", () => {
    const setExtra = vi.fn();
    const extra = { other: 1, caps: { "cc/b": { contextWindow: 600000, maxTokens: 16000 } } };
    const tree = PiModelCaps(props(["cc/a", "cc/b"], extra, setExtra));

    findByLabel(tree, "Context window for cc/a").props.onChange({ target: { value: "400000" } });

    expect(setExtra).toHaveBeenCalledWith({
      other: 1,
      caps: {
        "cc/a": { contextWindow: 400000, maxTokens: PI_DEFAULT_CAPS.maxTokens },
        "cc/b": { contextWindow: 600000, maxTokens: 16000 },
      },
    });
  });

  it("writes a changed max output while keeping the model's context window", () => {
    const setExtra = vi.fn();
    const extra = { caps: { "cc/b": { contextWindow: 600000, maxTokens: 16000 } } };
    const tree = PiModelCaps(props(["cc/b"], extra, setExtra));

    findByLabel(tree, "Max output tokens for cc/b").props.onChange({ target: { value: "128000" } });

    const next = setExtra.mock.calls[0][0];
    expect(next.caps["cc/b"]).toEqual({ contextWindow: 600000, maxTokens: 128000 });
    expect(capsFor(next, "cc/b")).toEqual({ contextWindow: 600000, maxTokens: 128000 });
  });
});
