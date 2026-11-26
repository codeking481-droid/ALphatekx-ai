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

1. Generate a new, self-contained HTML document whose composition, colors, visible text, shapes, and CSS keyframe motion specifically match the user's brief. Do not reuse a previous animation or a generic Biz template.
2. Keep the visual responsive, readable, and accessible, with a reduced-motion fallback. Use Emerald and Charcoal only when they fit the request or as the default palette.
3. Use inline CSS and, only when needed for the requested interaction, inline JavaScript. Never use event-handler attributes, external scripts, network requests, workers, remote resources, or embedded external content.
4. For "make it different" or "make another one," use the earlier brief as context and deliberately change the visual direction.
5. Call `motion_graphics_create` with the complete HTML and a short `.html` filename.
6. Tell the user the motion graphic is ready; include its preview and download links.

Use the subject and details the user provided. If optional style, timing, or layout preferences are missing, choose polished defaults and create a first draft instead of asking. For a Biz intro without a specified title, use "Biz".

If AI providers are unavailable or cannot return safe, usable HTML, do not create or return a substitute template. Tell the user no animation file was generated and include the provider failure details available in the chat.

## What not to do

Never execute uploaded or generated scripts on the server. Generated inline scripts run only when the user explicitly opens the isolated browser preview; preview network access is blocked. Do not claim that a video or GIF was created; this skill produces a standalone HTML animation.
