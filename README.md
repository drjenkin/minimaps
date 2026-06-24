# Minimap Maker

Browser-based generator for map relief "pucks" — squared-off terrain tiles built
from satellite imagery draped over real elevation data. Pan a map, frame a
region, and a textured 3D model pops out the other end, ready to export as PNG,
WebM, STL, OBJ, or GLB.

![Mariposa County, California](media/mariposa_county_california.jpg)

## Gallery

<table>
  <tr>
    <td width="33%"><img src="media/mollepata_cusco.jpg" alt="Mollepata, Cusco, Peru"><br><sub>Mollepata, Cusco</sub></td>
    <td width="33%"><img src="media/butte_county_idaho.jpg" alt="Butte County, Idaho"><br><sub>Butte County, Idaho</sub></td>
    <td width="33%"><img src="media/urrugne_nouvelle-aquitaine_france.jpg" alt="Urrugne, Nouvelle-Aquitaine, France"><br><sub>Urrugne, France</sub></td>
  </tr>
</table>

## What it does

- **Frame** any spot on Earth on a satellite map with country borders and labels.
- **Capture** the region — imagery is stitched and draped over a real elevation
  model to build a 3D relief puck with cream side walls and a flat base.
- **Style** it with filters, lighting, and z-exaggeration controls.
- **Export** as PNG, WebM (spinning turntable), STL / OBJ (for 3D editors), or
  GLB (textured, for the web / game engines).
- **Save** pucks to a local in-browser library — nothing leaves your machine.

## Quick start

You need Python 3 (with Flask). Then:

```bash
pip install -r requirements.txt
python backend/app.py
```

Open <http://127.0.0.1:5001/> in your browser.

On Windows you can just double-click **`launch.bat`**, which starts the server
and opens the browser for you.

## Elevation data — pick your source

When you capture, choose an elevation source:

- **Copernicus DEM 30m** (default, sharpest) — served via
  [OpenTopography](https://opentopography.org), which needs a **free API key**.
  The app prompts you for it the first time; it's stored only in your browser.
- **AWS Terrain** — keyless and global, no signup. Pick this if you'd rather
  skip the key step.

## Data sources & attribution

Minimap Maker is a non-commercial, personal-use project. Pucks are derived works
of the data sources below — if you redistribute them, follow each provider's
licence terms.

- **Elevation** — Copernicus DEM (ESA) and AWS Open Terrain Tiles, via
  [OpenTopography](https://opentopography.org) where applicable.
- **Satellite imagery** — Esri World Imagery (© Esri, Maxar, Earthstar
  Geographics).
- **Map / buildings / water / labels** — ©
  [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors and Esri
  reference layers.
- **Place names** — [Nominatim](https://nominatim.org) reverse geocoding.
- **3D engine** — [three.js](https://threejs.org).
- **Built with** — [Claude](https://claude.com/claude-code) (Anthropic).

## Credits

By [Mike](https://x.com/ShutterCG). If you enjoy Minimap Maker, you can
[buy me a coffee on Ko-fi](https://ko-fi.com/mike101441). ☕
