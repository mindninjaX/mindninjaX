#!/usr/bin/env node
// Builds assets/banner.svg — the one visual on the profile.
//
// The wordmark is Syne, and it animates along Syne's own weight axis from Regular to
// ExtraBold. Syne is a width-varying design, so heavier is also considerably wider: the
// word grows into the space rather than just thickening. That is the whole idea, and it is
// only possible because a variable font keeps identical path topology at every weight, so
// the two outlines can be interpolated directly.
//
// Three constraints shaped how this is built:
//
//   1. A README loads images through <img>, which gives the SVG no network access. A
//      webfont reference would silently fall back to Helvetica, so all type is converted
//      to outlines at build time.
//   2. GitHub has a light and a dark theme. The inline <style> carries a
//      prefers-color-scheme block, so one file covers both and there is no <picture>.
//   3. The static state is the finished ExtraBold. Motion is layered on top inside a
//      prefers-reduced-motion query, so anyone who asked their OS for less motion, or
//      whose browser lacks CSS `d` interpolation, gets the correct wordmark and no
//      broken intermediate state.
//
// Usage:  node assets/build-banner.mjs
// Fonts:  Syne + Outfit, both OFL, vendored in assets/fonts/ with their licenses.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import opentype from 'opentype.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── canvas ──────────────────────────────────────────────────────────────────
// A README renders about 880px wide, so 1500 wide scales to roughly 0.59. These numbers
// are chosen for how they land at that size, not at 1:1.
//
// Height and baselines are derived from the measured cap height further down rather than
// hardcoded, because the wordmark is fitted to the canvas: change its wording and the type
// resizes, which would leave hand-tuned padding wrong in a way that is easy to miss.
const W = 1500;
const PAD = 74;
const PAD_TOP = 32;
const PAD_BOTTOM = 30;
const SUB_SIZE = 25;
const SUB_GAP = 34;           // cap-height baseline to subline baseline, less the sub size

// Read off rishabh.design, where it marks the availability line. That site is otherwise
// achromatic, so this is the whole palette, and it holds against both GitHub themes.
const ACCENT = '#35c220';
const WORDMARK = 'DESIGN ENGINEER';
const SUBLINE = 'every link below is live';
const TRACK = -1.5;           // Syne sets loose at display size
const LIGHT = 400;            // weight the animation starts from
const HEAVY = 800;            // weight it rests at

// ── type ────────────────────────────────────────────────────────────────────
const buffers = {
  syne: readFileSync(join(HERE, 'fonts/Syne.ttf')),
  outfit: readFileSync(join(HERE, 'fonts/Outfit.ttf')),
};

const REF = 1000; // outlines are cached at this size and scaled down, for precision

/**
 * Varied outline and advance for one character, cached per (family, weight, char).
 *
 * Two hard-won rules are baked into these seven lines, and undoing either reintroduces a
 * bug that produces plausible-looking output rather than an error:
 *
 *   1. Fresh parse per entry. font.variation.getTransform() mutates the glyph it is handed
 *      and is not idempotent, so asking one parsed font for the same glyph repeatedly
 *      degrades it. The fit() loop below asks about thirty times, and the thirtieth answer
 *      came back with NaN coordinates.
 *   2. Measured exactly once, at the origin. Everything afterwards is arithmetic on the
 *      returned commands, so no glyph is ever put through the variation machinery twice.
 *
 * getTransform is still the only route that applies gvar deltas to an individual glyph:
 * glyph.getPath() alone silently returns the default instance, which is how this banner
 * first rendered in Syne Regular while the code claimed ExtraBold.
 */
const outlines = new Map();
function outline(family, weight, ch) {
  const key = `${family}@${weight}/${ch}`;
  if (!outlines.has(key)) {
    const font = opentype.parse(buffers[family]);
    const glyph = font.charToGlyph(ch);
    const coords = { wght: weight };
    const advance = font.variation.getTransform(glyph, coords).advanceWidth / font.unitsPerEm;
    const commands = glyph.getPath(0, 0, REF, { variation: coords }, font).commands;

    const nums = commands.flatMap((c) => [c.x, c.y, c.x1, c.y1, c.x2, c.y2].filter((n) => n !== undefined));
    // An SVG path parser stops at the first token it cannot read and drops the rest of the
    // element, so one NaN silently truncates the line instead of erroring. That shipped
    // once as a subline reading "ever" where "every link below is live" should have been.
    if (ch !== ' ' && (!commands.length || nums.some((n) => !Number.isFinite(n)))) {
      throw new Error(`unusable outline for ${JSON.stringify(ch)} in ${family}@${weight}`);
    }
    outlines.set(key, { commands, advance, kernGlyph: glyph, font });
  }
  return outlines.get(key);
}

const r = (n) => Math.round(n * 100) / 100;

/**
 * Text to path data. Returns { d, width }.
 *
 * Set glyph by glyph rather than via font.getPath(): letter-spacing needs per-glyph
 * placement anyway, and Outfit carries a GSUB lookup (substFormat 2 under lookupType 6)
 * that opentype.js throws on, which takes out the whole multi-character path.
 */
function type(family, text, { size, weight, x = 0, y = 0, tracking = 0 }) {
  const scale = size / REF;
  const chars = [...text];
  const parts = [];
  let cursor = x;

  chars.forEach((ch, i) => {
    const g = outline(family, weight, ch);
    if (ch !== ' ') {
      for (const c of g.commands) {
        if (c.type === 'Z') { parts.push('Z'); continue; }
        const px = (n) => r(n * scale + cursor);
        const py = (n) => r(n * scale + y);
        if (c.type === 'M') parts.push(`M${px(c.x)} ${py(c.y)}`);
        else if (c.type === 'L') parts.push(`L${px(c.x)} ${py(c.y)}`);
        else if (c.type === 'Q') parts.push(`Q${px(c.x1)} ${py(c.y1)} ${px(c.x)} ${py(c.y)}`);
        else if (c.type === 'C') parts.push(`C${px(c.x1)} ${py(c.y1)} ${px(c.x2)} ${py(c.y2)} ${px(c.x)} ${py(c.y)}`);
      }
    }
    cursor += g.advance * size + tracking;
    const next = chars[i + 1];
    // Kerning comes from the default instance. Syne's kern deltas across the weight axis
    // are under a unit at these sizes, below the rounding applied above.
    if (next) {
      cursor += (g.font.getKerningValue(g.kernGlyph, g.font.charToGlyph(next)) / g.font.unitsPerEm) * size;
    }
  });

  return { d: parts.join(''), width: cursor - x - tracking };
}

/**
 * Largest size at or below `max` that keeps `text` inside `target`.
 *
 * Fitted rather than hardcoded because Syne ExtraBold is close to twice the advance of
 * Regular: a size that fits at one weight overflows the canvas at the other, and the
 * wordmark should survive an edit to its own wording.
 */
function fit(family, text, { weight, target, max, tracking = 0 }) {
  let size = max;
  while (size > 8 && type(family, text, { size, weight, tracking }).width > target) size -= 0.25;
  return size;
}

// ── build ───────────────────────────────────────────────────────────────────
// The caret sits at the end of the word, so it has to travel as the word widens.
const railW = W - PAD * 2;
const CARET_GAP = 16;
const CARET_W = 15;

const size = fit('syne', WORDMARK, {
  weight: HEAVY,
  target: railW - CARET_GAP - CARET_W,
  max: 92,
  tracking: TRACK,
});

// Cap height, measured off the D that the caret sits beside rather than taken from the
// font's declared metrics, which on a variable font describe the default instance.
// Outline coordinates are already y-down, so the top of the letter is the smallest y.
const capHeight = (() => {
  const ys = outline('syne', HEAVY, 'D').commands
    .flatMap((c) => [c.y, c.y1, c.y2])
    .filter((n) => Number.isFinite(n));
  return (-Math.min(...ys) * size) / REF;
})();

const BASELINE = PAD_TOP + capHeight;
const SUB_BASELINE = BASELINE + SUB_GAP + SUB_SIZE;
const H = Math.round(SUB_BASELINE + SUB_SIZE * 0.22 + PAD_BOTTOM); // 0.22em covers the descender

const heavy = type('syne', WORDMARK, { size, weight: HEAVY, x: PAD, y: BASELINE, tracking: TRACK });
const light = type('syne', WORDMARK, { size, weight: LIGHT, x: PAD, y: BASELINE, tracking: TRACK });
const sub = type('outfit', SUBLINE, { size: SUB_SIZE, weight: 400, x: PAD, y: SUB_BASELINE });

// Verify the two weights can actually be interpolated before writing a file that claims to.
// A mismatch here would animate as a jump between two unrelated shapes.
const shape = (d) => (d.match(/[MLQCZ]/g) || []).join('');
if (shape(light.d) !== shape(heavy.d)) {
  throw new Error('path topology differs between weights, so the d interpolation would break');
}

const caretShift = (heavy.width - light.width).toFixed(1);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Design engineer. Every link below is live.">
  <style>
    .ink   { fill: #16181d; }
    .muted { fill: #6b7280; }
    .mark  { fill: ${ACCENT}; }
    @media (prefers-color-scheme: dark) {
      .ink   { fill: #ecedef; }
      .muted { fill: #8b93a1; }
    }

    /* The resting state above is the finished wordmark. Everything below is additive, so a
       reduced-motion request, or a browser without CSS \`d\` interpolation, still gets the
       right picture. */
    @media (prefers-reduced-motion: no-preference) {
      .word  { animation: weight 1150ms cubic-bezier(0.16, 1, 0.3, 1) 120ms both; }
      .caret { animation: follow 1150ms cubic-bezier(0.16, 1, 0.3, 1) 120ms both; }
      .sub   { animation: fade 700ms ease-out 900ms both; }
    }
    @keyframes weight {
      from { d: path("${light.d}"); }
      to   { d: path("${heavy.d}"); }
    }
    @keyframes follow {
      from { transform: translateX(-${caretShift}px); }
      to   { transform: translateX(0); }
    }
    @keyframes fade {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: none; }
    }
  </style>

  <path class="ink word" d="${heavy.d}"/>
  <rect class="mark caret" x="${(PAD + heavy.width + CARET_GAP).toFixed(1)}" y="${(BASELINE - capHeight).toFixed(1)}"
        width="${CARET_W}" height="${capHeight.toFixed(1)}" rx="2.5"/>
  <path class="muted sub" d="${sub.d}"/>
</svg>
`;

writeFileSync(join(HERE, 'banner.svg'), svg);
console.log(
  `banner.svg — ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB · wordmark ${size}px, ` +
  `${light.width.toFixed(0)}px at ${LIGHT} growing to ${heavy.width.toFixed(0)}px at ${HEAVY} ` +
  `(caret travels ${caretShift}px) · cap height ${capHeight.toFixed(1)}px, canvas ${W}x${H}`,
);
