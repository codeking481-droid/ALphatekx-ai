---
name: motion-graphics
description: Create animated intros, animated text, logo animations, and downloadable HTML motion graphics.
version: 1.0.0
permissions:
  - tool:approved
tools:
  - motion_graphics_create
creates:
  - file
  - animation
---

## When to use

Use when the user asks for an animated intro, logo animation, animated text, motion graphic, or short visual loop.

## Steps

1. Make a self-contained HTML document with a clear title and CSS keyframe animation.
2. Keep the visual responsive, readable, and accessible, with a reduced-motion fallback. Use Emerald and Charcoal as the default Biz palette.
3. Use inline CSS only. Do not include scripts, event handlers, remote resources, or embedded external content.
4. Call `motion_graphics_create` with the complete HTML and a short `.html` filename.
5. Tell the user the motion graphic is ready; include its preview and download links.

## What not to do

Never execute uploaded or generated scripts. Do not claim that a video or GIF was created; this skill produces a standalone HTML animation.
