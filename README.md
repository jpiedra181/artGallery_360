# Inside the Frame — Vol. I: Water

An interactive exhibition that turns four public-domain paintings about water into 360° worlds you can stand in:

| Room | Painting | Collection |
| --- | --- | --- |
| I — Wave | Katsushika Hokusai, *Under the Wave off Kanagawa*, c. 1830–32 | The Metropolitan Museum of Art |
| II — Rain | Utagawa Hiroshige, *Sudden Shower over Shin-Ōhashi Bridge and Atake*, 1857 | The Metropolitan Museum of Art |
| III — Stillness | Claude Monet, *Water Lily Pond*, 1900 | The Art Institute of Chicago |
| IV — Moonlight | J. M. W. Turner, *Keelmen Heaving in Coals by Moonlight*, 1835 | National Gallery of Art, Washington |

The visitor starts in a dark gallery whose floor is flooded with still water. Selecting a painting glides up to it and dives through the canvas into its world.

## How it is made

**Worlds** are generated entirely from Python scripts in Blender 5 (`blender/scripts/`), rendered as 8K equirectangular panoramas with Cycles and finished in post:

- the two woodblock prints are lit by emission only (flat colours); ink outlines are drawn afterwards from depth, normal and object-id passes, and paper grain and block mottling are added (`scripts/looks.py`);
- the two oil paintings are rendered with real light, then painted with an anisotropic Kuwahara filter, brush strokes that follow the local structure of the image, impasto relief and canvas weave.

A **semantic mask** is rendered for every world (R water, G sky, B light sources).

**The viewer** (`src/scripts/`) is a dependency-free WebGL2 renderer (~19 KB gzipped for the whole app):

- a single fullscreen shader casts a ray per pixel and samples the panorama — exact projection, no sphere mesh, seam-safe mipmapping, and a stereographic blend for wide portrait screens;
- the mask drives real-time layers on top of the still render: ripples on water (with drops falling in the gallery), rain in two directions with impacts on the river, flickering fires, a drifting sky, the rocking of a boat;
- transitions are a water-drop dissolve between two scenes;
- panoramas stream in strips so uploads never stall a frame; scenes open at 4K and upgrade to 8K on capable screens; the resolution adapts to keep the frame rate smooth;
- sound is synthesised live with Web Audio and positioned in 3D (HRTF) around the visitor — no audio files.

**The site** is static [Astro](https://astro.build): one page per room, readable without JavaScript, navigated without reloads when it is available.

## Accessibility

- every room has a written description of its world and of the painting; the exhibition can be followed entirely without seeing it;
- keyboard: arrow keys look around, + and − zoom, Tab reaches the paintings and points of interest (the view turns to show what has focus), Escape closes panels;
- screen readers: semantic landmarks and headings, a labelled 360° view, announcements when moving between rooms, focus management;
- animation can be paused at any time and is off when the system asks for reduced motion; sound is opt-in;
- WCAG 2.2 AA checked with axe-core; contrast-safe surfaces over the imagery; 44 px touch targets; works from 320 px wide, in portrait and landscape, with safe-area insets;
- without WebGL2 the page falls back to stills and text.

## Working on it

```sh
npm install
npm run dev          # http://localhost:4321
npm run build        # static site in dist/
```

Set `SITE_URL` when building for production so canonical and Open Graph URLs are absolute:

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
python scripts/make_stills.py wave
node scripts/build-assets.mjs wave
```

Scenes: `hub`, `wave`, `rain`, `stillness`, `moonlight`. The hub script also writes `src/data/hub-geometry.json`, which the viewer uses for exact hit-testing of the paintings. `scripts/pano_views.py` previews any panorama as flat views.

## Credits

- Katsushika Hokusai, *Under the Wave off Kanagawa* — The Metropolitan Museum of Art, H. O. Havemeyer Collection, Bequest of Mrs. H. O. Havemeyer, 1929 (JP1847). Public domain, CC0.
- Utagawa Hiroshige, *Sudden Shower over Shin-Ōhashi Bridge and Atake* — The Metropolitan Museum of Art, Purchase, Joseph Pulitzer Bequest, 1918 (JP643). Public domain, CC0.
- Claude Monet, *Water Lily Pond* — The Art Institute of Chicago, Mr. and Mrs. Lewis Larned Coburn Memorial Collection (1933.441). Public domain, CC0.
- J. M. W. Turner, *Keelmen Heaving in Coals by Moonlight* — National Gallery of Art, Washington, Widener Collection (1942.9.86). Open access, CC0.
- Textures from [Poly Haven](https://polyhaven.com) (CC0): Plastered Wall 04 and Square Floor by Rob Tuytel, Oak Wood Planks by Dimitrios Savva.
- Type: Instrument Serif and Instrument Sans (SIL Open Font License).

Concept, 3D, sound and code by Javier Piedra.
