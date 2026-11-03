---
name: design-guard
license: CC0-1.0
description: Use for browser interaction and visual creation or revision. Verify operation targets and results; measure Web, GUI, SVG, Word, PowerPoint, PDF, diagrams, images and video to prevent regressions. Excludes prose-only or nonvisual code edits without browser interaction.
---

- **Browser interaction:** read [browser operations](references/browser.md). Use Chrome DevTools MCP, without switching to Playwright. Browsing, input and saving alone do not require the visual-production steps below. Apply both workflows when also creating or revising appearance.
- Preserve user instructions, approved design and edit scope. Inspect references directly. Visual-only work must preserve content, behavior, numbers, required wording and captions. Propose out-of-scope improvements; review-only requests do not authorize edits.
- Revisions cover changed elements, comparisons and affected areas. Align same-role dimensions, baselines, text, padding and colors; retain meaningful differences. Titles state subject and point briefly; put explanation in body text. Reconsider layout/wrapping before shrinking isolated text.
- Read [creation](references/create.md) **only when building an artifact from scratch**. Revisions, new sessions and follow-up edits do not reset creation mode.
- **Read only applicable references.** CSS/GUI/SVG: [measurement](references/measure.md) plus [CSS](references/css.md), [GUI](references/gui.md) or [SVG](references/svg.md). Word/PowerPoint/PDF: [documents](references/documents.md) plus [Word](references/word.md), [PowerPoint](references/powerpoint.md) or [PDF](references/pdf.md). Measure actual targets and comparisons for other visual media too.
- Inspect the intended application's actual display or delivered format. Distinguish frames, inner shapes and text bounds; measure edges, dimensions, spacing and centers. Include affected pages, scenes and intermediate states. Code values, another renderer or a converted PDF do not certify the original format.
- Batch related fixes, remeasure under matching conditions and inspect images until instructions are met, identified issues are resolved and no new regression remains. Avoid per-edit whole-artifact audits; share same-version evidence. Report unavailable measurements or stalled improvements as unresolved, not complete.
- After work, retain comparison baselines and before/after images, measurements and records needed for verification and reporting; delete unnecessary inspection images and intermediate outputs. Preserve evidence referenced by checks even after verification passes.
- Briefly report before/after evidence and unverified areas. Independent review requires a request or significant concrete risk; give the reviewer these instructions and actual artifacts. Do not add tools or delegation arbitrarily. Keep project-specific values in the project; record material sources/licenses and never infer publication permission.
