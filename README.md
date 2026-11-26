<a href="https://artgallery360.art"><img src="public/og.jpg" alt="Four paintings in a dark flooded gallery, over a paper label that reads: Inside the Frame, Vol. I — Water. Hokusai, Hiroshige, Monet, Turner" width="100%"></a>

# Inside the Frame — Vol. I: Water

An interactive exhibition that turns four public-domain paintings about water into 360° worlds you can stand in.

**[Live site ↗](https://artgallery360.art)** · Built by [Javier Piedra](https://jpiedra.com/en/)

> Personal project. Every artwork is public domain, every texture CC0 and every typeface open-licensed (see [Credits](#credits)).

## Overview

Online collections usually show a painting as a flat image with a caption. Inside the Frame asks what it would feel like to step into one. The visitor starts in a dark gallery whose floor is flooded with still water; selecting a painting glides up to it and dives through the canvas into its world.

| Room | Painting | Collection |
| --- | --- | --- |
| I — Wave | Katsushika Hokusai, *Under the Wave off Kanagawa*, c. 1830–32 | The Metropolitan Museum of Art |
| II — Rain | Utagawa Hiroshige, *Sudden Shower over Shin-Ōhashi Bridge and Atake*, 1857 | The Metropolitan Museum of Art |
| III — Stillness | Claude Monet, *Water Lily Pond*, 1900 | The Art Institute of Chicago |
| IV — Moonlight | J. M. W. Turner, *Keelmen Heaving in Coals by Moonlight*, 1835 | National Gallery of Art, Washington |

Two reading pages sit beside the exhibition: **[How it was made](https://artgallery360.art/making-of/)**, which follows one world from the painting to the browser, and **[About and credits](https://artgallery360.art/about/)**.

The same approach suits museums, galleries, cultural foundations, hotels and brands that want an immersive experience people actually remember.

## Highlights

- **Worlds built in Blender, generated from code.** Every scene is produced by Python scripts in Blender 5 and rendered as an 8K equirectangular panorama with Cycles.
- **Painted, not just rendered.** The two woodblock prints are lit by emission only (flat colours), with ink outlines drawn afterwards from depth, normal and object-id passes, plus paper grain and block mottling. The two oils are made of paint: Monet's pond is about 430,000 strokes hung in space, each coloured from the part of the painting it stands for; Turner's river is his painting read as some 95,000 strokes, from broad to fine, and carried on from its margins all the way round. Impasto relief and canvas weave are added afterwards.
- **A wave that falls.** The Great Wave is not rendered but drawn, live, from a few curves read off the print and one shape of claw (about 125,000 flat triangles in painter's order, no image). The lip comes down, breaks, sinks and rises again, and stands for a moment at the instant Hokusai chose. Only its anchors are worked out on the CPU; the graphics card moves the triangles that hang from them. The pointer combs the foam and shakes spray off it; on a touch screen, where a finger that moves only looks round, a tap strikes the foam and throws spray to the side it came from.
- **People who run.** In the rain, the print's passers-by are drawn live by the same engine, caught in mid-stride, and then run. The pointer is an umbrella nobody sees: whoever is under it stops running and walks. On a touch screen a tap holds it over the nearest of them, and it goes along with them. The rain itself is drawn in the shader as long thin lines at two angles, as cut in the block.
- **A day and two lights.** In Monet's garden the wind crosses the strokes, the pads ride the pond and rings follow the pointer (or spread from a tap, and a gust goes through the leaves); a day goes by over it, from the afternoon of the painting through sunset, a night of fireflies, mist and noon, back to the light he chose. On Turner's river the clouds turn round the moon, smoke and sparks go up and keels are rowed across its road; the fires and the moon take turns, and whichever is looked at holds.
- **Living stills.** A semantic mask per world (R water, G sky, B light sources) drives real-time layers on top of the render: ripples on water (with drops falling in the gallery), rain in two directions with impacts on the river, flickering fires, a drifting sky, a rocking boat, clouds that run, ships that ride the water, wind in the leaves and the hour of the day.
- **Loose strokes.** Leaves, petals, dragonflies, smoke, embers, gulls and spray are single touches of a brush, instanced over the panorama with the same projection, parallax and depth.
- **Depth, not a flat sphere.** Each world ships a depth map from the same Blender scene. The viewer uses it to move the eye a few centimetres around the point the panorama was rendered from: near things slide over far ones as you turn, as the mouse moves and as the boat rocks.
- **Authored entrances.** Arriving in a world is a camera move: the view starts off its mark and a little way back, and settles as the scene opens. Dragging during it simply joins in.
- **Through the canvas.** Entering a painting, a drop lands where you touched it. Pigment blooms from that point like ink let into water — Prussian blue for Hokusai, white gold for Turner — the surface swells and ripples, and behind the bloom the picture is already a place: the world first appears warped onto its painting by a registration grid (`scripts/registration.py`), so what is painted turns into what is there. Leaving runs the other way: the dark of the gallery closes in on the world until it is a painting on the wall again.
- **A beginning and an end.** Two lines are read over the dark water before the gallery comes into view, with its four paintings, one to a wall. At the foot of the view hangs the label of the painting in front, as a museum hangs one beside each work: room, title, painter and date, and under it the one thing in the gallery that looks pressable, “Step inside”, with arrows to the painting before or after. On a tall screen, which could only hold the four small, the camera goes along the walls as it rises and comes up close to one painting; a swipe turns to the next and comes to rest in front of it. On a wide screen, left alone, the gallery lights its paintings not yet entered one after another, as it does under the pointer, and the label follows. Each room entered leaves its pigment in the water under its painting; after the fourth, the view goes down to the water again, the rooms are named one by one while their colours spread and meet, and the closing words stand where the title stood.
- **Detail where it is looked at.** The painting pointed at, entered or left borrows the fine detail of its own picture, which the gallery's panorama has no pixels for.
- **Generative sound.** Synthesised live with Web Audio and positioned in 3D (HRTF) around the visitor — no audio files. The gallery holds a note for each room visited; the four make a chord. The rooms are levelled by measurement (integrated loudness, recorded from the page): within about 1 dB of -24 LUFS, the gallery a little quieter. Nothing is scheduled while the page is in the background, an interrupted context comes back at the next touch, and on an iPhone it plays with the ring switch on silent.

## Tech stack and decisions

| Area | Choice |
|---|---|
| Site | Static [Astro](https://astro.build): one page per room, readable without JavaScript, navigated without reloads when it is available; two plain reading pages (`/making-of/`, `/about/`), a sitemap and robots.txt |
| Viewer | A dependency-free **WebGL 2** renderer (~38 KB gzipped for the app, plus 26 KB for what is drawn live in the rooms, loaded with them) |
| 3D production | Blender 5 + Cycles, scripted in Python (`blender/scripts/`) |
| Post-processing | Python (`scripts/looks.py`, `scripts/post.py`) |
| Audio | Web Audio API with HRTF panning |
| Testing | axe-core; Playwright in Chrome, Firefox and WebKit |

- **No sphere mesh.** A fullscreen shader, compiled per scene with only what that scene uses, casts a ray per pixel and samples the panorama: exact projection, seam-safe mipmapping, and a stereographic blend for wide portrait screens.
- **Parallax in the same shader.** The ray is bent by eye offset ÷ distance, solved in three rounds per pixel against an 8-bit disparity map (10–15 KB per world). Foreground edges are dilated when the map is built, so silhouettes move whole instead of tearing.
- **Streaming without stalls.** Panoramas stream in strips so uploads never block a frame (rows are skipped with `UNPACK_SKIP_ROWS`: cutting strips with `createImageBitmap` fails in Firefox); scenes open at 4K and upgrade to 8K on capable screens; resolution adapts to keep the frame rate smooth. On a phone the view is drawn at no more than 1.5 pixels to the point (fewer still while two scenes cross), the drawings of the wave and the rain are made ahead, while the prologue is read, and posed every other frame, and the sound's noise is made between frames, so that moving from one place to another never waits on the processor.

## Accessibility and performance

- Every room has a written description of its world and of the painting; the exhibition can be followed entirely without seeing it.
- **Keyboard:** arrow keys look around, + and − zoom, Tab reaches the paintings and points of interest (the view turns to show what has focus, clear of the panels), Escape closes panels and button labels.
- **The act of each room** (the wave falling, people running, the day going by, the fires) plays by itself and is asked for nothing: one button with a pause sign, or the space bar over the view, stops everything that moves and starts it again. With reduced motion it waits for play.
- **Single pointer, no dragging or pinching:** a button in the corner (on a phone, "Buttons to look and zoom" in the Rooms menu) opens look and zoom buttons that turn and zoom one step per click or tap (it stays open on later visits), and "Look closer" on each room card lists its points of interest; choosing one turns the view to it and opens its note.
- **Controls that step back:** after a few seconds without input the interface fades and leaves the view to the painting (longer on a touch screen, where there is no telling that someone is reading); any movement, touch or key brings it back, and the tap that brings it back presses nothing under the finger. It never fades while something is open, while the keyboard is on a control or with animation paused, and it stays in the tab order and the accessibility tree throughout.
- **Screen readers:** semantic landmarks and headings, a labelled 360° view, announcements when moving between rooms, focus management.
- Animation can be paused at any time and is off when the system asks for reduced motion — that includes the parallax, the camera moves on arriving and the prologue, and transitions become a plain cross-fade. There is one way in: sound fades in with it, the button to turn it off is at the top from the first moment, and turning it off is remembered.
- The prologue is announced to screen readers and any key, click or tap skips it. The ending works the same way: any key, click or tap skips it, and its lines are announced. The closing words are a non-modal dialog: it takes focus so it is read out, Escape puts it away, and nothing behind it is closed off. With reduced motion or animation paused, they simply appear.
- WCAG 2.2 AA checked with axe-core; contrast-safe surfaces over the imagery; 44 px touch targets; works from 320 px wide, in portrait and landscape, with safe-area insets.
- Without WebGL 2, the page falls back to stills and text.

## Getting started

Requires Node 22.12 or later.

```sh
npm install
npm run dev          # http://localhost:4321
npm run build        # static site in dist/
```

Canonical and Open Graph URLs are built for `https://artgallery360.art`. Set `SITE_URL` to build for another address:

```sh
SITE_URL=https://example.com npm run build
```

### Rebuilding the worlds

Requires Blender 5.0, Python 3 (`pip install -r requirements.txt`) and Node.

```sh
# 1. download the artworks (public domain, CC0) into blender/sources/ and
#    the Poly Haven textures into blender/textures/ (see Credits)

# 2. build a scene and save its .blend
blender -b --factory-startup -P blender/scripts/run_scene.py -- --scene wave --final --save

# 3. render the 8K panorama, mask and line passes
blender -b blender/wave.blend -P blender/scripts/render.py -- --name wave --width 8192 --samples 64 --passes depth,normal,id

# 4. finish, make stills, encode AVIF/WebP tiers and update src/data/assets.json
python scripts/post.py wave
node scripts/draw-sheet.mjs wave    # wave and rain: what is drawn live, for their stills
python scripts/make_stills.py wave
node scripts/build-assets.mjs wave
```

The pictures on the making-of page are cut from the same render passes (the four frames of the dive are captured from the running site and kept in `blender/renders/process/`):

```sh
node scripts/draw-sheet.mjs wave 0 0.18 0.36 0.82
node scripts/draw-sheet.mjs rain
python scripts/make_process.py
node scripts/build-assets.mjs process
```

To add or refresh only the depth maps, render the pass alone and encode it without touching the panoramas:

```sh
blender -b blender/wave.blend -P blender/scripts/render.py -- --name wave --width 4096 --no-beauty --no-mask --passes depth
node scripts/build-assets.mjs wave --depth-only   # or --mask-only
```

Moonlight starts from strokes read off the painting; run this once before building it:

```sh
python scripts/strokes_from_picture.py moonlight
```

`python scripts/registration.py` writes `src/data/registration.json`, where each part of a painting is in its world; run it again after moving things in a scene.

Scenes: `hub`, `wave`, `rain`, `stillness`, `moonlight`. The hub script also writes `src/data/hub-geometry.json`, which the viewer uses for exact hit-testing of the paintings. `scripts/pano_views.py` previews any panorama as flat views.

## Credits

- Katsushika Hokusai, *Under the Wave off Kanagawa* — The Metropolitan Museum of Art, H. O. Havemeyer Collection, Bequest of Mrs. H. O. Havemeyer, 1929 (JP1847). Public domain, CC0.
- Utagawa Hiroshige, *Sudden Shower over Shin-Ōhashi Bridge and Atake* — The Metropolitan Museum of Art, Purchase, Joseph Pulitzer Bequest, 1918 (JP643). Public domain, CC0.
- Claude Monet, *Water Lily Pond* — The Art Institute of Chicago, Mr. and Mrs. Lewis Larned Coburn Memorial Collection (1933.441). Public domain, CC0.
- J. M. W. Turner, *Keelmen Heaving in Coals by Moonlight* — National Gallery of Art, Washington, Widener Collection (1942.9.86). Open access, CC0.
- Textures from [Poly Haven](https://polyhaven.com) (CC0): Plastered Wall 04 and Square Floor by Rob Tuytel, Oak Wood Planks by Dimitrios Savva.
- The lettering on the gallery walls: Ibarra Real Nova (`blender/fonts/`), SIL Open Font License.
- Type: Ibarra Real Nova and Libre Franklin (SIL Open Font License).

---

Concept, 3D, sound and code by **[Javier Piedra](https://jpiedra.com/en/)** — WordPress, 3D web and accessible front-ends. Want an immersive experience for your collection or brand? [Get in touch](mailto:contacto@jpiedra.com).
