# Design system — Futures of Parasocial AI

Two connected worlds: the **app** (light, Heartful Futures "Earthy Foresight") and the **home page dark acts** (the same palette pushed to near-black, instrument-observation register borrowed from specimen photography).

## Core tokens (`server/public/css/style.css`)

- Triad: olive `#4E5A2B` (frameworks/primary), brown `#AC7222` (citations/secondary), mustard `#E1B83B` + goldenBrown `#D3963E` (insight/emphasis)
- Ink: charcoal `#282E2A`, textMid `#656B5E`, textDim `#6A6A5F` (fib.css resolves these; the older `#6B7264` / `#9A9A8A` no longer reach the page)
- Surfaces: warmWhite `#FFFEF9` (never pure white), cream `#FAF7F2`, oliveLight `#F5F6F0`, brownLight `#FBF5EC`, mustardLight `#FEF9E7`
- Status: urgentRed `#C44536`, watchBlue `#5B8A9A`
- Radii 14px cards / 8px boxes / 100px pills; olive-tinted shadows only; triad gradient reserved for the 3px top bar
- Type: Lexend 300 body (line-height 1.6–1.8), 700 titles, 800 heroes, 900 display with tight negative tracking; 10px/+3px uppercase labels
- Archetype chart palette (CVD-checked display order): growth `#D3963E`, collapse `#C44536`, discipline `#5B8A9A`, transformation `#4E5A2B`

## Home dark act extension (`server/public/css/home.css`)

- `--void: #101408` — olive-black canvas (the house green pushed to near-black; never neutral `#000`)
- `--void-ink: #F5F6F0` — display text on void; secondary dark-canvas text `#B9BFAD`
- Instrument annotations: **Fragment Mono** 11px uppercase, letter-spaced, with 1px reticle-cornered boxes; values are real platform numbers
- Chips on void: mustardLight bg / charcoal text, mono face (the acid-chip move translated into the house triad)
- Motion: rAF scroll → CSS custom properties; ease-out-expo; every effect has a `prefers-reduced-motion` static equivalent; content visible by default, JS only enhances

## Voice in UI

Sentence case everywhere except 10px tracked labels. Citations live in brown boxes. Uncertainty vocabulary is native. No emoji, no decorative unicode; icons only Lucide 1.5px stroke when genuinely needed.
