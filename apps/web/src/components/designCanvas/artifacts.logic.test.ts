import { describe, expect, it } from "vite-plus/test";

import { findProjectArtifacts, parseArtifactIndex } from "./artifacts.logic";

const paths = [
  "src/app.ts",
  "design/canvas.json",
  "design/screens/home.html",
  "artifacts/index.json",
  "artifacts/key-iphone-screens/SOURCE.md",
  "artifacts/key-iphone-screens/project/canvas.json",
  "artifacts/key-iphone-screens/project/Main.dc.html",
  "artifacts/key-iphone-screens/project/support.js",
  "artifacts/ios-build-plan/SOURCE.md",
  "artifacts/ios-build-plan/document.md",
  "artifacts/paid-study/document.md",
  "artifacts/paid-study/document.html",
  "artifacts/year-one/index.html",
  "artifacts/design-system/project/README.md",
  "artifacts/design-system/project/tokens.json",
  "artifacts/design-system/project/components/Button/preview.html",
  "artifacts/key-iphone-screens/project/ds/resona/tokens.json",
  "artifacts/mockups/home.html",
  "artifacts/mockups/settings.html",
  "artifacts/calculator.html",
  "artifacts/onboarding/canvas.json",
  "artifacts/onboarding/screens/welcome.html",
  "artifacts/budget/budget.csv",
  "artifacts/notes.md",
  "artifacts/empty/SOURCE.md",
];

describe("findProjectArtifacts", () => {
  it("classifies each artifact folder by what it holds", () => {
    const index = parseArtifactIndex(
      JSON.stringify({
        "ios-build-plan": { title: "Venna · iOS app build plan", updatedAt: "2026-10-08" },
        "key-iphone-screens": { title: "Venna · Key iPhone Screens", updatedAt: "2026-10-10" },
      }),
    );
    const artifacts = findProjectArtifacts(paths, index);
    expect(artifacts.map(({ id, title, kind, content }) => ({ id, title, kind, content }))).toEqual(
      [
        {
          id: "design",
          title: "Project designs",
          kind: "design",
          content: { _tag: "ProjectCanvas", root: "design" },
        },
        {
          id: "artifacts/key-iphone-screens",
          title: "Venna · Key iPhone Screens",
          kind: "design",
          content: { _tag: "ClaudeCanvas", root: "artifacts/key-iphone-screens/project" },
        },
        {
          id: "artifacts/ios-build-plan",
          title: "Venna · iOS app build plan",
          kind: "doc",
          content: { _tag: "Document", path: "artifacts/ios-build-plan/document.md" },
        },
        {
          id: "artifacts/budget",
          title: "Budget",
          kind: "sheet",
          content: { _tag: "Sheet", path: "artifacts/budget/budget.csv", delimiter: "," },
        },
        {
          id: "artifacts/calculator.html",
          title: "Calculator",
          kind: "page",
          content: { _tag: "Page", path: "artifacts/calculator.html" },
        },
        {
          id: "artifacts/design-system",
          title: "Design system",
          kind: "system",
          content: { _tag: "DesignSystem", root: "artifacts/design-system/project" },
        },
        {
          id: "artifacts/mockups",
          title: "Mockups",
          kind: "design",
          content: {
            _tag: "Screens",
            root: "artifacts/mockups",
            files: ["home.html", "settings.html"],
          },
        },
        {
          id: "artifacts/notes.md",
          title: "Notes",
          kind: "doc",
          content: { _tag: "Document", path: "artifacts/notes.md" },
        },
        {
          id: "artifacts/onboarding",
          title: "Onboarding",
          kind: "design",
          content: { _tag: "ProjectCanvas", root: "artifacts/onboarding" },
        },
        {
          id: "artifacts/paid-study",
          title: "Paid study",
          kind: "doc",
          content: { _tag: "Document", path: "artifacts/paid-study/document.md" },
        },
        {
          id: "artifacts/year-one",
          title: "Year one",
          kind: "page",
          content: { _tag: "Page", path: "artifacts/year-one/index.html" },
        },
      ],
    );
  });

  it("tolerates a missing or broken index", () => {
    expect(parseArtifactIndex(null).size).toBe(0);
    expect(parseArtifactIndex("{ nope").size).toBe(0);
    expect(
      parseArtifactIndex(JSON.stringify({ artifacts: { "./a/": { title: " A " } } })).get("a"),
    ).toEqual({ title: "A", updatedAt: null });
  });
});
