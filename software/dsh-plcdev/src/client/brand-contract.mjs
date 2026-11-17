// Canonical visual contract. Run tools/sync-plcdev-brand.mjs after changing it.
export const brandName = 'PLCdev';
export const brandMark = '-()-';
// Approved unframed, flat-ended mark: 24px canvas, 3.2px nominal stroke.
// The shared 19px mark adds .15 units of optical weight, matching the demo.
// Curves adapted from Lucide parentheses (ISC; notice in CSS below).
const smallStroke = 3.35;
const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="${smallStroke}" stroke-linecap="butt" stroke-linejoin="miter"><g transform="translate(.96 .96) scale(.92)" stroke-width="${smallStroke/.92}"><path transform="translate(.75 0)" d="M8 21s-4-3-4-9 4-9 4-9"/><path transform="translate(-.75 0)" d="M16 3s4 3 4 9-4 9-4 9"/></g><path d="M1.49 12H5.33M18.67 12h3.84"/></svg>`;
const scope = '.plcdev-scope, button[aria-label="'+brandName+'"]:has(.plcdev-entry-mark)';
const light={accent:'#7250B8',tint:'#F1EBFA',onAccent:'#fff'};
const dark={accent:'#C9AEFF',tint:'#31263E',onAccent:'#231831'};
export const brandCss = `
/* Lucide parentheses — ISC License
Copyright (c) 2026 Lucide Icons and Contributors
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.
THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
*/
${scope} {
  --plcdev-accent: ${light.accent};
  --plcdev-tint: ${light.tint};
  --plcdev-on-accent: ${light.onAccent};
  --plcdev-mark-size: 19px;
  --plcdev-rail-size: 3px;
}
@supports (color: light-dark(white, black)) {
  ${scope} {
    --plcdev-accent: light-dark(${light.accent}, ${dark.accent});
    --plcdev-tint: light-dark(${light.tint}, ${dark.tint});
    --plcdev-on-accent: light-dark(${light.onAccent}, ${dark.onAccent});
  }
}
.plcdev-scope.plcdev-rail {
  box-sizing: border-box;
  border-inline-start: var(--plcdev-rail-size) solid var(--plcdev-accent);
}
.plcdev-title {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: .15em .5em;
  min-inline-size: 0;
  max-inline-size: 100%;
  overflow-wrap: anywhere;
}
.plcdev-identity {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  color: var(--plcdev-accent);
  white-space: nowrap;
  font-weight: 600;
}
.plcdev-title-compact { flex-wrap: nowrap; align-items: center; }
.plcdev-title-compact > span:last-child { min-inline-size: 0; }
.plcdev-mark {
  display: inline-grid;
  place-items: center;
  flex: none;
  inline-size: var(--plcdev-mark-size);
  block-size: var(--plcdev-mark-size);
  color: var(--plcdev-accent);
  background: transparent;
  border-radius: 0;
  font: 700 8px/1 ui-monospace, monospace;
}
@supports (mask-image: url("")) {
  .plcdev-mark { position: relative; font-size: 0; }
  .plcdev-mark::before {
    content: "";
    position: absolute;
    inset: 0;
    inline-size: 100%;
    block-size: 100%;
    background: currentColor;
    mask: url("data:image/svg+xml,${encodeURIComponent(markSvg)}") center / contain no-repeat;
    pointer-events: none;
    forced-color-adjust: none;
  }
}
.plcdev-scope :is(button, a, select, input, textarea, summary):focus-visible,
.plcdev-scope:is(button, [role=tab]):focus-visible {
  outline: 2px solid var(--plcdev-accent);
  outline-offset: 2px;
}
.plcdev-scope .plcdev-link:not(:disabled):not([aria-disabled=true]) {
  color: var(--plcdev-accent);
  text-decoration: underline;
  text-underline-offset: .16em;
}
.plcdev-scope .plcdev-action {
  background: var(--plcdev-accent);
  border-color: var(--plcdev-accent);
  color: var(--plcdev-on-accent);
}
.plcdev-scope .plcdev-action:hover:not(:disabled) { filter: brightness(.95); }
.plcdev-scope .plcdev-selected.plcdev-selected,
.plcdev-scope .plcdev-tab[aria-current=page],
.plcdev-scope .plcdev-tab[aria-expanded=true],
.plcdev-scope[role=tab][aria-selected=true] {
  background-color: var(--plcdev-tint);
  color: var(--plcdev-accent);
  text-decoration: underline;
  text-underline-offset: .24em;
}
@media (forced-colors: active) {
  ${scope} {
    --plcdev-accent: LinkText;
    --plcdev-tint: Canvas;
    --plcdev-on-accent: Canvas;
  }
  .plcdev-mark { color: CanvasText; }
}
`;
