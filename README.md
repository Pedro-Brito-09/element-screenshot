# Element Screenshot

Chrome/Edge extension (Manifest V3) that saves a PNG of any element on the page, children included.
The PNG goes to **Downloads** and to the **clipboard**.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.

## Use

Click the toolbar icon or press **Alt+Shift+S** (change it in `chrome://extensions/shortcuts`).

| Action | Effect |
|---|---|
| Hover | highlights the element under the cursor |
| Wheel / ↑ ↓ | select the parent / go back to the child |
| Click or Enter | capture |
| Esc or middle-click | cancel |
| B or right-click | background: off (only what the element paints) / on (fills its box) |
| PageUp / PageDown, scrollbar | scroll the page while picking |

Started from the toolbar icon, Chrome keeps keyboard focus in its own UI and no key reaches the
page. The picker then shows a full-screen overlay asking you to click the page; picking starts on
that click, with all keys working. Started with the shortcut, picking begins right away.

## How it works

- **High resolution:** during a capture the extension attaches Chrome's debugger and re-renders the tab at
  2× pixel density (or the screen's own, if higher) without changing the layout. Chrome shows a
  "started debugging this browser" bar meanwhile; it goes away when the capture ends.
- **Exact shape:** the element is captured twice, over black and over white, with everything else
  hidden. Comparing the two gives exactly what the element paints, as transparency: an SVG logo
  comes out as the logo alone, with correct anti-aliasing and no page background.
- **Background option (`B`):** off by default. Turned on, the element's whole box is kept —
  border and rounded corners included — and filled with the background really behind it, from a
  third capture where the ancestors stay visible but siblings and overlays do not. Use it for
  panels and cards whose own background is transparent, or whose border is semi-transparent.
- **Clean edges:** the crop is snapped inward to whole device pixels, so the element's own
  `box-shadow` and the page behind do not bleed into the edges.
- Elements larger than the window are captured in scrolled tiles and stitched together.

## Limitations

- Does not run on `chrome://` pages, the Web Store or the built-in PDF viewer (badge shows `!`).
- Anti-aliased pixels on rounded corners keep a trace of the background color behind them.
- Only the page is scrolled: content hidden inside an inner scroll container is not expanded.
- Animated content may differ between the passes or show seams between tiles.
- Photos not served in high resolution are simply upscaled at 2×.
- Huge elements are downscaled to stay within canvas limits.
- Clipboard copy can be blocked by a page's `Permissions-Policy`; the download still works and a toast says so.
- Capturing fails if another debugger (e.g. another extension) is attached to the tab.
