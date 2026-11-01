# Twiglane app icon

`twiglane-logo.png` is the final 1024 × 1024 blue-violet icon master with a transparent outer margin. `twiglane-logo-source.png` preserves the raw generated artwork.

The image was generated with the configured provider's Responses `image_generation` tool (`gpt-image-2.5`, high quality), using the provider-loading and generation functions from the user-specified `Rillight/tool/generate_app_icons.py`. The exact generation prompt is in `twiglane-logo-prompt.txt`.

After generation, the user's blue-violet preference was applied to the green portions of the artwork while preserving the ivory glyph, shading and geometry. The edge-connected white background was converted to alpha. Application theme tokens were not changed.

Tauri's icon CLI derived the committed PNG, ICO and ICNS assets from the final master. `public/brand-icon.png` is a tightly framed 256px variant for the application interface; `public/favicon.png` is its 64px variant. No provider credentials are stored here.

To regenerate platform assets from the final master, run `npm run tauri -- icon output/imagegen/twiglane-logo.png --output <staging-directory>`, then copy the corresponding desktop files into `src-tauri/icons/`.
