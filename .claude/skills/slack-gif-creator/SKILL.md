---
name: slack-gif-creator
description: Create animated GIFs optimized for Slack — emoji size (128x128) or message size (480x480). Use when asked to make a GIF, animated emoji, or Slack reaction image.
---

Create animated GIFs using Python + Pillow.

SPECIFICATIONS:
- Emoji GIFs:  128×128px, 10–30 FPS, 48–128 colors, ≤3 second loop
- Message GIFs: 480×480px, same FPS/color guidance

IMPLEMENTATION PATTERN:
```python
from PIL import Image, ImageDraw
import imageio

frames = []
for i in range(24):  # 24 frames = 1s at 24fps
    img = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # ... draw primitives for this frame ...
    frames.append(img.convert("RGB"))

imageio.mimsave("output.gif", frames, fps=24, loop=0)
```

ANIMATION TECHNIQUES:
- **Motion**: shake `x = base + amp*sin(t)`, bounce with easing, slide via lerp
- **Transform**: pulse `scale = 1 + 0.2*sin(t)`, rotate, zoom
- **Appearance**: fade `alpha = int(255 * t/n)`, particle burst, color cycle

FILE SIZE OPTIMIZATION (if > 256KB for emoji):
1. Lower FPS: 24 → 15 → 10
2. Reduce palette: 128 → 64 → 48 colors
3. Reduce dimensions if message GIF
4. Remove duplicate frames

PILLOW PRIMITIVES: `draw.ellipse()`, `draw.rectangle()`, `draw.polygon()`, `draw.text()`, `draw.line()`

INSTALL: `pip install Pillow imageio`
