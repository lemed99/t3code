import { describe, expect, it } from "vite-plus/test";

import {
  parseDesignTokens,
  previewDocument,
  previewFixedWidth,
  readPreviewCard,
  tokensCss,
} from "./designSystem.logic";

const tokens = parseDesignTokens(
  JSON.stringify({
    name: "Venna",
    color: {
      themes: [
        { id: "light", name: "Sand" },
        { id: "dark", name: "Evening" },
      ],
      tokens: [
        { name: "surface", value: { light: "#F6EEE6", dark: "#22152A" }, usage: "Background" },
        { name: "danger", value: "#E25A4E" },
        { name: "bad name!", value: "#000" },
        { name: "sneaky", value: "red;}body{display:none" },
      ],
    },
    type: { families: { display: '"Fraunces", serif' }, groups: [] },
    spacing: { tokens: [{ name: "space-1", value: "4px" }] },
    radius: { tokens: [{ name: "radius-pill", value: "999px" }] },
    shadow: { tokens: [] },
  }),
);

describe("design tokens", () => {
  it("reads themed colors and drops names or values that are not safe CSS", () => {
    expect(tokens?.themes.map((theme) => theme.id)).toEqual(["light", "dark"]);
    expect(tokens?.colors.map((color) => color.name)).toEqual(["surface", "danger"]);
  });

  it("writes every token as a CSS variable for the chosen theme", () => {
    expect(tokensCss(tokens!, "dark")).toBe(
      ':root{--surface: #22152A;--danger: #E25A4E;--font-display: "Fraunces", serif;--space-1: 4px;--radius-pill: 999px;}',
    );
  });

  it("injects the variables into a preview's head", () => {
    expect(previewDocument("<html><head><title>x</title></head></html>", ":root{}")).toBe(
      "<html><head><style>:root{}</style><title>x</title></head></html>",
    );
  });

  it("reads preview card metadata and fixed widths", () => {
    expect(readPreviewCard('<!-- @dsCard group="Actions" height=260 -->\n<html>')).toEqual({
      group: "Actions",
      height: 260,
    });
    expect(readPreviewCard("<html>")).toEqual({ group: null, height: null });
    expect(previewFixedWidth(".cv{position:relative;width:960px;height:288px}")).toBe(960);
    expect(previewFixedWidth(".w{max-width:358px}")).toBeNull();
  });
});
