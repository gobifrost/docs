import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
describe("application font delivery", () => {
  it("keeps bootstrap styles independent of external font services", () => {
    const html = readFileSync(resolve(root, "index.html"), "utf8");
    const css = readFileSync(resolve(root, "src/index.css"), "utf8");
    expect(html + css).not.toMatch(/https?:\/\/fonts\.(?:googleapis|gstatic)\.com/);
    expect(css).toContain('@import "./assets/fonts/fonts.css"');
  });

  it("ships the canonical families, variable weight ranges, and licensed local payloads", () => {
    const dir = resolve(root, "src/assets/fonts");
    const css = readFileSync(resolve(dir, "fonts.css"), "utf8");
    for (const family of ["Inter", "Prompt", "JetBrains Mono"]) expect(css).toContain(`font-family: '${family}'`);
    expect(css).toContain("font-weight: 100 900");
    expect(css).toContain("font-weight: 400 800");
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map(match => match[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith("./")).toBe(true);
      expect(existsSync(resolve(dir, url))).toBe(true);
    }
    for (const name of ["inter-OFL.txt", "prompt-OFL.txt", "jetbrainsmono-OFL.txt"]) {
      expect(readFileSync(resolve(dir, name), "utf8")).toContain("SIL OPEN FONT LICENSE");
    }
  });
});
