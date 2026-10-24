import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Read from disk (tests run from frontend/): a CSS import is empty under the test runner.
const css = readFileSync("src/index.css", "utf8");

/**
 * Motion stays smooth when it animates what the compositor can move without
 * layout or paint: transform and opacity (and an SVG stroke being drawn).
 * A few one-shot animations paint briefly; they are named here with why.
 * Nothing that repeats may paint — a breathing dot repeats on every row.
 */
const COMPOSITED = new Set(["transform", "opacity", "stroke-dashoffset"]);
const ONE_SHOT_PAINT: Record<string, string> = {
  "th-row-new": "a table row that arrived live is tinted once; a cell cannot carry an overlay",
  "th-ring-in": "a donut chart's segments sweep in once (custom properties)",
  "th-cp-ring-draw": "the client health ring draws once",
  "th-presence-in": "a teammate's presence ring pops once",
};

function keyframes(source: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    let depth = 1;
    let i = re.lastIndex;
    while (depth > 0 && i < source.length) {
      if (source[i] === "{") depth++;
      if (source[i] === "}") depth--;
      i++;
    }
    const body = source.slice(re.lastIndex, i - 1).replace(/[^{}]*\{/g, "");
    const props = new Set([...body.matchAll(/(?:^|[\s;])((?:--)?[a-z][a-z-]*)\s*:/g)].map((m) => m[1]));
    out.set(match[1], props);
  }
  return out;
}

function repeating(source: string): Set<string> {
  const names = new Set<string>();
  for (const decl of source.matchAll(/animation(?:-name)?\s*:\s*([^;]+);/g)) {
    if (!/\binfinite\b/.test(decl[1])) continue;
    for (const word of decl[1].split(/[\s,]+/)) if (word.startsWith("th-") || word.startsWith("m-")) names.add(word);
  }
  return names;
}

describe("motion budget", () => {
  const frames = keyframes(css);

  it("animates only composited properties, apart from the named one-shots", () => {
    const painting = [...frames]
      .filter(([name, props]) => !(name in ONE_SHOT_PAINT) && [...props].some((p) => !COMPOSITED.has(p)))
      .map(([name, props]) => `${name}: ${[...props].join(", ")}`);
    expect(painting).toEqual([]);
  });

  it("never repeats an animation that paints", () => {
    const loops = [...repeating(css)].filter((name) => name in ONE_SHOT_PAINT);
    expect(loops).toEqual([]);
  });

  it("reads the stylesheet's animations", () => {
    expect(frames.size).toBeGreaterThan(30);
    expect([...frames.get("th-progress")!]).toEqual(["transform"]);
    expect(frames.get("th-row-new")).toContain("background-color");
    expect(repeating(css)).toContain("th-dot-ring");
  });

  it("names no exception that no longer exists", () => {
    expect(Object.keys(ONE_SHOT_PAINT).filter((name) => !frames.has(name))).toEqual([]);
  });
});
