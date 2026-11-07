import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("./tokens.css", import.meta.url)),
  "utf8",
);
const sections = css.split('[data-theme="dark"]');
function palette(source: string) {
  const definitions: Record<string, string> = Object.fromEntries(
    [...source.matchAll(/--([\w-]+):\s*(#[a-f\d]{6}|var\(--[\w-]+\));/gi)].map(
      (match) => [match[1]!, match[2]!],
    ),
  );
  function resolve(name: string): string {
    const value = definitions[name];
    if (!value) throw new Error(`Missing colour token: ${name}`);
    const reference = /^var\(--([\w-]+)\)$/.exec(value);
    return reference ? resolve(reference[1]!) : value;
  }
  return Object.fromEntries(
    Object.keys(definitions).map((name) => [name, resolve(name)]),
  );
}
const themes = {
  light: palette(sections[0]!),
  dark: { ...palette(sections[0]!), ...palette(sections[1]!.split("@theme")[0]!) },
};
function luminance(hex: string) {
  const rgb = hex
    .slice(1)
    .match(/../g)!
    .map((value) => parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe.each(Object.entries(themes))("%s workspace palette", (_name, tokens) => {
  it("keeps mixed navigation labels, focus and control edges readable", () => {
    for (const background of ["nav-bg", "nav-selected"])
      for (const foreground of ["nav-text", "nav-muted", "nav-accent"])
        expect(contrast(tokens[foreground]!, tokens[background]!), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["nav-accent"]!, tokens["nav-bg"]!)).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens["nav-border"]!, tokens["nav-selected"]!)).toBeGreaterThanOrEqual(3);
  });
  it("keeps every body-text token readable on its declared working surfaces", () => {
    for (const background of [
      "bg", "surface", "surface-2", "frame", "surface-panel", "surface-floating",
    ])
      for (const foreground of [
        "text-1",
        "text-2",
        "text-3",
        "accent",
        "partial",
        "done",
        "overdue",
      ])
        expect(
          contrast(tokens[foreground]!, tokens[background]!),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(tokens["text-1"]!, tokens["accent-soft"]!),
    ).toBeGreaterThanOrEqual(4.5);
  });
  it("keeps action labels readable across button states", () => {
    for (const state of ["accent", "accent-hover", "accent-press"])
      expect(
        contrast(tokens["on-accent"]!, tokens[state]!),
        `on-accent on ${state}`,
      ).toBeGreaterThanOrEqual(4.5);
    for (const label of ["text-1", "text-2"])
      expect(
        contrast(tokens[label]!, tokens["surface-3"]!),
        `${label} on pressed surface`,
      ).toBeGreaterThanOrEqual(4.5);
  });
  it("keeps focus, input edges and profile marks visible without decorative borders", () => {
    for (const token of [
      "control-border",
      "accent",
      ...Object.keys(tokens).filter((name) => name.startsWith("profile-")),
    ])
      for (const background of [
        "bg", "surface", "surface-2", "surface-3", "accent-soft",
        "frame", "surface-panel", "surface-floating",
      ])
        expect(
          contrast(tokens[token]!, tokens[background]!),
          `${token} on ${background}`,
        ).toBeGreaterThanOrEqual(3);
    expect(
      contrast(tokens["accent"]!, tokens["progress-track"]!),
      "recorded progress against its unfilled track",
    ).toBeGreaterThanOrEqual(3);
  });
});
