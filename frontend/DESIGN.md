# Design guidelines

The dashboard uses an **editorial, technical-document** aesthetic: cream paper, sharp black borders, monospace eyebrows, hard drop shadows. Think IBM design archive / Linear-marketing-page, not SaaS dashboard.

Reference image: `numerai_landing_page.png` (not committed — local design reference only).

## 1. Color tokens

Defined in `src/routes/+layout.svelte` under `:global(:root)`.

| Token | Value | Use |
| --- | --- | --- |
| `--bg-page` | `#fbfaf7` | Page background. The cream. |
| `--bg-card` | `#ffffff` | Cards, panels, nodes. |
| `--bg-input` | `#f7f6f2` | Form inputs, info rows. |
| `--text` | `#171717` | Body text, all borders. |
| `--text-secondary` | `#5d5a52` | Sub-labels, helper copy. |
| `--text-muted` | `#8b8579` | Eyebrows (uppercase), captions. |
| `--green` | `#1a7f37` | "Linked" / "live" status. |
| `--red` | `#cf222e` | Destructive actions. |
| `--orange` / `--purple` / `--yellow` | various | Status badges only — sparingly. |
| `--border` / `--border-light` | tan grays | Soft dividers inside forms. |
| `--hover-bg` | `#f5f2eb` | Hover wash on neutral buttons. |
| `--nav-height` | `88px` (56 mobile) | Used by fullscreen layouts to compute remaining height. |

**Do not** introduce vibrant brand colors (electric blue, etc.) as global accents. We tried PI-blue gradients and reverted them — the editorial cream/black is the look.

## 2. Typography

- Body: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`.
- Mono: `--font-mono` = `SFMono-Regular, Consolas, 'Liberation Mono', monospace`.
- **Eyebrow rule**: small labels above titles use `font-family: var(--font-mono); font-size: 0.6–0.72rem; font-weight: 800; letter-spacing: 0.1–0.14em; text-transform: uppercase; color: var(--text-muted)`. This is the most recognizable text pattern.
- Headlines: 1.5–1.65rem, weight 720, line-height 1.2.
- Sub-labels: 0.74–0.78rem, `--text-secondary`, single line + ellipsis.

## 3. Borders, radius, shadows

- Borders are **`var(--text)`** (near-black), not gray. Default `1.5px`; bump to `2px` for emphasized cards (hub node, primary panels).
- Radius: **`4px`** for boxes, **`6px`** for outer shells, **`999px`** for pill chips. Never higher than 6px — the look is intentionally hard-edged.
- Drop shadow: **hard offset**, not blur. `box-shadow: 3px 3px 0 var(--text);` (or `4px 4px 0` for hub-level). On hover: lift by `translate(-1px, -1px)` and increase shadow to `4px 4px 0`.
- Inputs and drawer controls follow the same physical model as nodes: focus/hover moves the element **top-left** and leaves the shadow down-right. Scroll containers need top/left breathing room so this translated state is never clipped.
- Status badges (when needed): use `--badge-blue / --badge-green / --badge-red` — translucent tints with no border.

## 4. Component patterns

### 4.1 Card head (eyebrow + title + sub)
The canonical card layout:

```
[ICON 38–40px]  EYEBROW (mono, uppercase)
                Title (0.85–0.92rem, weight 720)
                Sub (0.74–0.78rem, --text-secondary)        [status dot]
```

Use this for: flow nodes, list rows, settings panels. Icon slot is a `1px solid var(--text)` outlined square with the glyph centered inside, background `var(--bg-page)`.

### 4.2 Status dot
8×8 circle. Default = `--text-muted`. "On" = `--green` with a `0 0 0 2px rgba(26,127,55,0.18)` halo. Reserve cyan/blue glows for things we don't have yet.

### 4.3 Dashed = empty / add
Any "add new" or empty-state node uses `border-style: dashed` with the `--text` color. Solid borders mean an entity exists.

### 4.4 Buttons
- `button` (default): `var(--text)` border, `var(--bg-card)` background, weight 700.
- `.primary`: solid black fill (`var(--text)`), white text.
- `.danger`: `var(--red)` border + text, no fill until hover.
- `.ghost`: no border, no background. For close/dismiss only.
- All buttons: `border-radius: 4px`, `padding: 0.5rem 0.85rem`. Disabled = `opacity: 0.6`.

## 5. Flow canvas

The settings page is a Svelte Flow canvas. Conventions:

- **Edges**: `smoothstep` type, `stroke: var(--text); stroke-width: 1.4`. `animated: true` only when both endpoints are linked. Dashed `4 4` for "add" edges.
- **Background**: dotted grid, `patternColor: rgba(23,23,23,0.08)`, `gap: 28`.
- **Controls**: present, `showLock={false}`. Style overrides: bordered `var(--text)`, hard `2px 2px 0` shadow, no rounded corners beyond 4px.
- **Nodes are non-draggable, non-connectable**. The flow is presentational — interaction is click-to-open-drawer, not free-form node editing. Keep it that way unless we're shipping pipeline authoring.
- **Provider add nodes** are direct default flow nodes connected from the hub. Keep Prime Intellect, Modal, AWS SageMaker, and Lambda Cloud visible as four branded dashed nodes labeled like "Add Modal"; clicking one should prefill the add-provider drawer.
- **Drawer**: right-side overlay, not a grid column. Use a large responsive width (`clamp(...)`), a hard border and offset shadow, and an independent scroll body. Do not squeeze the canvas to make room for the drawer. Internally: eyebrow + title fixed at top, scrollable form/content below.
- **Scrollable drawer body**: give the scroll region top/left inset or equivalent negative margin + padding so focused inputs can translate `-1px, -1px` without clipping their borders or shadows.

## 6. Fullscreen layout

`/settings` runs full-bleed. The pattern:

1. The top `+layout.svelte` switches `<main>` to a `fullbleed` class when `$page.url.pathname` matches (`max-width: none; padding: 0; margin: 0`).
2. The page itself uses `height: calc(100vh - var(--nav-height, 88px))` for its canvas container.
3. `--nav-height` is set globally and overridden in the `max-width: 768px` media query.

Use this pattern when adding more flow-canvas pages (e.g. a future `/pipelines` graph builder). For everything else, stay inside the 1280px constrained `<main>`.

## 7. Animation

Restrained. The only animations in use are:
- Hover lift on cards/nodes (`transform: translate(-1px, -1px)`, 120ms).
- Svelte Flow edge dashes (`animated: true`) — built-in.

No fade-ins, parallax, or "delight" microinteractions. The cream/black palette doesn't need them; movement should be reserved for *signal* (e.g. animated edge = active link), not ambience.

## 8. What we tried and dropped

- **Prime Intellect blue/cyan gradient theme** with glowing edges and animated SVG flow lines. Got built, reverted on owner feedback. Don't reintroduce — if a future feature needs a strong accent, prefer the green "linked" indicator already in the palette, or add a single new token explicitly.
- **Standalone FlowSheet component** (a labeled-box diagram, then a PI-themed flowsheet). Replaced by the real Svelte Flow canvas. If you find yourself building a static flow diagram with HTML/SVG, ask whether it should be a real `SvelteFlow` instance instead.

## 9. Open conventions / gaps

- No dark mode yet. If added, the editorial aesthetic should translate to off-black bg with cream/bone text, **not** the standard dark-SaaS navy.
- Provider nodes should use the static logo assets in `static/provider-logos/` when available. Keep the logo inside the existing 40–42px outlined square so branding does not break the editorial node layout.
- The `/builder`, `/models`, `/compute`, `/ml`, `/chart` pages predate this guide and don't all follow these conventions yet. Update opportunistically.
