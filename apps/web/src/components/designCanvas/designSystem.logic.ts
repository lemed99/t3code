/**
 * A design system copied from Claude Design: `tokens.json` (colors with
 * themes, type, spacing, radius, shadows), a `README.md`, and component
 * previews in `components/<Name>/preview.html` written against the tokens as
 * CSS variables (`var(--surface)`, `var(--font-display)`, ...).
 */

export interface ThemeOption {
  readonly id: string;
  readonly name: string;
}

export interface ColorToken {
  readonly name: string;
  /** Value per theme id; a single value applies to every theme. */
  readonly values: Readonly<Record<string, string>>;
  readonly usage: string | null;
}

export interface ValueToken {
  readonly name: string;
  readonly value: string;
  readonly usage: string | null;
}

export interface TypeStyle {
  readonly name: string;
  readonly family: string;
  readonly fontSize: string;
  readonly lineHeight: string;
  readonly fontWeight: string;
  readonly letterSpacing: string | null;
  readonly fontStyle: string | null;
  readonly textTransform: string | null;
  readonly sample: string;
  readonly usage: string | null;
}

export interface TypeGroup {
  readonly name: string;
  readonly styles: ReadonlyArray<TypeStyle>;
}

export interface DesignTokens {
  readonly name: string | null;
  readonly themes: ReadonlyArray<ThemeOption>;
  readonly colors: ReadonlyArray<ColorToken>;
  /** Family key (`display`, `text`) to CSS font stack. */
  readonly families: Readonly<Record<string, string>>;
  readonly typeGroups: ReadonlyArray<TypeGroup>;
  readonly spacing: ReadonlyArray<ValueToken>;
  readonly radius: ReadonlyArray<ValueToken>;
  readonly shadows: ReadonlyArray<ValueToken>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : null;

// Token names become CSS custom property names; anything else is dropped.
const TOKEN_NAME = /^[a-zA-Z][\w-]*$/;
// Values go inside a style element, so they must not close it or start a block.
const isSafeCssValue = (value: string) => !/[<>{};]/.test(value);

const readValueTokens = (section: unknown): ValueToken[] =>
  (isRecord(section) && Array.isArray(section.tokens) ? section.tokens : []).flatMap((token) => {
    if (!isRecord(token)) return [];
    const name = readString(token.name);
    const value = readString(token.value);
    return name && value && TOKEN_NAME.test(name) && isSafeCssValue(value)
      ? [{ name, value, usage: readString(token.usage) }]
      : [];
  });

export function parseDesignTokens(contents: string | null): DesignTokens | null {
  if (contents === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const color = isRecord(raw.color) ? raw.color : {};
  const themes = (Array.isArray(color.themes) ? color.themes : []).flatMap((theme) => {
    const id = isRecord(theme) ? readString(theme.id) : null;
    return id ? [{ id, name: (isRecord(theme) && readString(theme.name)) || id }] : [];
  });
  const colors = (Array.isArray(color.tokens) ? color.tokens : []).flatMap(
    (token): ColorToken[] => {
      if (!isRecord(token)) return [];
      const name = readString(token.name);
      if (!name || !TOKEN_NAME.test(name)) return [];
      const values: Record<string, string> = {};
      if (isRecord(token.value)) {
        for (const [theme, value] of Object.entries(token.value)) {
          const text = readString(value);
          if (text && isSafeCssValue(text)) values[theme] = text;
        }
      } else {
        const text = readString(token.value);
        if (text && isSafeCssValue(text)) values["*"] = text;
      }
      return Object.keys(values).length > 0
        ? [{ name, values, usage: readString(token.usage) }]
        : [];
    },
  );
  const type = isRecord(raw.type) ? raw.type : {};
  const families: Record<string, string> = {};
  if (isRecord(type.families)) {
    for (const [key, value] of Object.entries(type.families)) {
      const stack = readString(value);
      if (stack && TOKEN_NAME.test(key) && isSafeCssValue(stack)) families[key] = stack;
    }
  }
  const typeGroups = (Array.isArray(type.groups) ? type.groups : []).flatMap(
    (group): TypeGroup[] => {
      if (!isRecord(group)) return [];
      const family = readString(group.family) ?? "text";
      const styles = (Array.isArray(group.styles) ? group.styles : []).flatMap(
        (style): TypeStyle[] => {
          if (!isRecord(style)) return [];
          const name = readString(style.name);
          if (!name) return [];
          const css = (value: unknown, fallback: string | null) => {
            const text = readString(value);
            return text && isSafeCssValue(text) ? text : fallback;
          };
          return [
            {
              name,
              family: css(style.family, family)!,
              fontSize: css(style.fontSize, "16px")!,
              lineHeight: css(style.lineHeight, "1.4")!,
              fontWeight: css(style.fontWeight, "400")!,
              letterSpacing: css(style.letterSpacing, null),
              fontStyle: css(style.fontStyle, null),
              textTransform: css(style.textTransform, null),
              sample: readString(style.sample) ?? name,
              usage: readString(style.usage),
            },
          ];
        },
      );
      return [{ name: readString(group.name) ?? family, styles }];
    },
  );
  return {
    name: readString(raw.name),
    themes,
    colors,
    families,
    typeGroups,
    spacing: readValueTokens(raw.spacing),
    radius: readValueTokens(raw.radius),
    shadows: readValueTokens(raw.shadow),
  };
}

/** The value a color takes in `theme`, falling back to the first theme's. */
export function colorValue(token: ColorToken, theme: string | null): string {
  return (
    (theme !== null ? token.values[theme] : undefined) ??
    token.values["*"] ??
    Object.values(token.values)[0] ??
    "transparent"
  );
}

/** Every token as a CSS variable, the way previews expect them. */
export function tokensCss(tokens: DesignTokens, theme: string | null): string {
  const lines = [
    ...tokens.colors.map((token) => `--${token.name}: ${colorValue(token, theme)};`),
    ...Object.entries(tokens.families).map(([key, stack]) => `--font-${key}: ${stack};`),
    ...[...tokens.spacing, ...tokens.radius, ...tokens.shadows].map(
      (token) => `--${token.name}: ${token.value};`,
    ),
  ];
  return `:root{${lines.join("")}}`;
}

/** `<!-- @dsCard group="Actions" height=260 -->` on the first line of a preview. */
export function readPreviewCard(html: string): {
  readonly group: string | null;
  readonly height: number | null;
} {
  const header = /<!--\s*@dsCard([^>]*)-->/.exec(html.slice(0, 400))?.[1] ?? "";
  const group = /group="([^"]+)"/.exec(header)?.[1] ?? null;
  const height = Number(/height=(\d+)/.exec(header)?.[1]);
  return { group, height: Number.isFinite(height) && height > 0 ? Math.min(height, 4000) : null };
}

/** The fixed width a preview lays itself out at (a cover, a banner), if any. */
export function previewFixedWidth(html: string): number | null {
  const width = Number(/(?<![-\w])width:\s*(\d{3,4})px/.exec(html)?.[1]);
  return Number.isFinite(width) && width >= 320 ? width : null;
}

/** A preview with the tokens in place, for a sandboxed `srcdoc` frame. */
export function previewDocument(html: string, css: string): string {
  const style = `<style>${css}</style>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head)
    return (
      html.slice(0, head.index + head[0].length) + style + html.slice(head.index + head[0].length)
    );
  return style + html;
}

/** The web-font stylesheet the previews load, so specimens use the same fonts. */
export function findFontStylesheet(html: string): string | null {
  const href = /href="(https:\/\/fonts\.googleapis\.com\/[^"]+)"/.exec(html)?.[1] ?? null;
  return href && !/[<>"]/.test(href) ? href : null;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One type style's sample, set in its own font, for a `srcdoc` frame. */
export function typeSpecimenDocument(
  style: TypeStyle,
  tokens: DesignTokens,
  theme: string | null,
  fontStylesheet: string | null,
): string {
  const declarations = [
    `font-family: ${tokens.families[style.family] ?? style.family}`,
    `font-size: ${style.fontSize}`,
    `line-height: ${style.lineHeight}`,
    `font-weight: ${style.fontWeight}`,
    style.letterSpacing ? `letter-spacing: ${style.letterSpacing}` : null,
    style.fontStyle ? `font-style: ${style.fontStyle}` : null,
    style.textTransform ? `text-transform: ${style.textTransform}` : null,
  ].filter(Boolean);
  const link = fontStylesheet ? `<link rel="stylesheet" href="${escapeHtml(fontStylesheet)}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8">${link}<style>${tokensCss(tokens, theme)}body{margin:0;padding:8px 0;background:transparent;color:var(--ink, #111);overflow:hidden}p{margin:0;${declarations.join(";")};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style></head><body><p>${escapeHtml(style.sample)}</p></body></html>`;
}
