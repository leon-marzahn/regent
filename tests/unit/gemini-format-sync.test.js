// gemini.js helpers changed in the 0.5.119 sync: remote image URLs become
// fileData parts with a mime type from the extension, multi-type schemas collapse
// to one Gemini type, and every array schema gets a typed `items`.
import { describe, it, expect } from "vite-plus/test";
import { convertOpenAIContentToParts, cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

const remote = (url) => convertOpenAIContentToParts([{ type: "image_url", image_url: { url } }])[0];

describe("convertOpenAIContentToParts — remote images", () => {
  it.each([
    ["https://cdn.example.com/a/photo.JPG", "image/jpeg"],
    ["https://cdn.example.com/a/photo.jpeg?x=1", "image/jpeg"],
    ["https://cdn.example.com/b.webp", "image/webp"],
    ["http://cdn.example.com/c.gif", "image/gif"],
    ["https://cdn.example.com/d.bmp#frag", "image/bmp"],
    ["https://cdn.example.com/e.png", "image/png"],
    ["https://cdn.example.com/no-extension", "image/png"],
  ])("%s → %s", (url, mimeType) => {
    expect(remote(url)).toEqual({ fileData: { fileUri: url, mimeType } });
  });

  it("falls back to the default mime type when the URL does not parse", () => {
    expect(remote("https://exa mple.com/x.gif").fileData.mimeType).toBe("image/png");
  });
});

const clean = (schema) => cleanJSONSchemaForAntigravity(structuredClone(schema));
const typeOf = (types, extra = {}) => clean({ type: "object", properties: { v: { type: types, ...extra } } }).properties.v;

describe("cleanJSONSchemaForAntigravity — type arrays", () => {
  it("collapses a null-only type to string and a single non-null type to itself", () => {
    expect(typeOf(["null"]).type).toBe("string");
    expect(typeOf(["integer", "null"]).type).toBe("integer");
  });

  it("prefers object when properties are present", () => {
    const v = typeOf(["string", "object"], { properties: { a: { type: "string" } } });
    expect(v.type).toBe("object");
    expect(v.properties.a.type).toBe("string");
  });

  it("prefers array when typed items are present", () => {
    const v = typeOf(["string", "array"], { items: { type: "number" } });
    expect(v).toEqual({ type: "array", items: { type: "number" } });
  });

  it.each([
    [["boolean", "string"], "string"],
    [["boolean", "number"], "number"],
    [["boolean", "integer"], "integer"],
    [["boolean", "null", "boolean"], "boolean"],
    [["object", "array"], "object"],
  ])("%j → %s", (types, expected) => {
    expect(typeOf(types).type).toBe(expected);
  });
});

describe("cleanJSONSchemaForAntigravity — array items", () => {
  const items = (itemsSchema) => clean({ type: "object", properties: { list: { type: "array", items: itemsSchema } } }).properties.list.items;

  it("types untyped items from their shape", () => {
    expect(items({ properties: { id: { type: "string" } } })).toEqual({ type: "object", properties: { id: { type: "string" } } });
    expect(items({ items: { type: "string" } })).toEqual({ type: "array", items: { type: "string" } });
    expect(items({ description: "anything" })).toEqual({ type: "string", description: "anything" });
  });

  it("keeps tool parameters literally named items, properties and required", () => {
    const out = clean({
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" } },
        properties: { type: "object", properties: { k: { type: "string" } } },
        required: { type: "boolean" },
      },
      required: ["items", "required"],
    });
    expect(out.properties.items).toEqual({ type: "array", items: { type: "string" } });
    expect(out.properties.properties).toEqual({ type: "object", properties: { k: { type: "string" } } });
    expect(out.properties.required).toEqual({ type: "boolean" });
    expect(out.required).toEqual(["items", "required"]);
  });

  it("still strips items from non-array schemas inside a properties map", () => {
    const out = clean({ type: "object", properties: { name: { type: "string", items: { type: "string" } } } });
    expect(out.properties.name).toEqual({ type: "string" });
  });

  it("fills a placeholder when items are missing or empty", () => {
    expect(items({})).toEqual({ type: "string" });
    expect(clean({ type: "array" })).toEqual({ type: "array", items: { type: "string" } });
  });
});
