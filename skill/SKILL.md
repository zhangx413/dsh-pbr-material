---
name: pbr-material-from-photo
description: Turn a photo of an object or surface into a tileable PBR material set (albedo/normal/height/roughness/AO/curvature/metallic, 8-bit and 16-bit). Use when the user wants to extract a material from a reference photo, asks for PBR maps or game-ready textures from an image, or reports that a generated material is not flat / not seamless / not faithful to the reference. Two modes, and choosing wrongly is the most common failure - "direct" for a photo that is already a flat front-facing texture (photo becomes the albedo, ~3 s, detail preserved) and "generate" for a photo of an object with perspective or lighting (a model reworks it first, ~30 s, detail re-invented). Runs fully local in ComfyUI.
---

# Photo → PBR material, the way that actually works

This skill exists because the obvious approaches fail in ways that cost hours. Read
the two architecture sections before writing any graph.

> **This copy ships with the `dsh-pbr-material` plugin.** Run the pipeline with
> `pbr_material_from_photo` instead of hand-writing graphs; the knowledge below is
> what you still need in order to choose the parameters, judge the output, and know
> when to stop. Machine paths come from the plugin's `config.json`, not from this file.

## FIRST: is step 1 even wanted? (`mode="direct"`)

Step 1 is a *reconstruction*. If the photo is already flat and front-facing, running
it is not just 26 s wasted — it **destroys the thing the user wanted**. Measured on a
747×1328 photo of a concrete wall that was already a straight-on texture:

| | albedo the pipeline produced |
|---|---|
| `mode="generate"` (step 1 + step 2) | uniform grey speckle, **formwork seams gone, aggregate patches gone, staining gone** |
| `mode="direct"` (step 2 only) | the photo itself: seams, exposed aggregate, air voids, staining all intact, native 747×1328 |

So make the choice explicitly, and **pass `mode` to `pbr_material_from_photo`**:

- **`mode="direct"`** — the photo IS the albedo. Tile it, derive the maps. No model, no
  prompt, ~3 s, the photo's own pixels and resolution survive untouched.
  Use when: the surface fills most of the frame, there is no perspective, no object
  silhouette, no significant lighting gradient — a wall, floor, metal sheet, fabric
  swatch, a scan or a downloaded texture. `material` is not needed; pass nothing.
- **`mode="generate"`** (default) — the photo is a *reference* to be reconstructed first.
  Use when: the photo shows an object at an angle, has perspective, background, a
  strong light falloff, or a curved surface.

**Ambiguous input:** if the surface is flat but the framing is angled, `direct` still
wins after a crop — the plugin does not crop for you, so say so rather than running
step 1 and losing detail. If the user's complaint is "it doesn't look like my photo
any more", check whether `generate` was used on a ready-made texture; that is the
usual cause. This is also why the panel asks the user which one, up front.

## The two-step architecture (do not collapse it into one)

```
reference photo
   │
   ├─ STEP 1  FLUX.2 Klein 4B, instruction edit  →  flat orthographic material image
   │          (removes object structure, perspective, background, lighting)
   │          SKIPPED entirely in mode="direct"
   │
   └─ STEP 2  deterministic pixel maths          →  tileable PBR set
              hue-selective colour match → make seamless → derive maps
              (colour match is a step-1 repair, so it is skipped in "direct" too)
```

**Why not one step.** Every single-step attempt measurably fails:

| Approach | Measured failure |
|---|---|
| Plain img2img, high denoise | removes perspective but **invents the model's own prior** - concrete came back as a regular tile grid (the user called it "you gave me marble") |
| Plain img2img, low denoise | keeps the material but **keeps the input's composition exactly** - the user called it "just a beautify filter", and perspective survives |
| txt2img from noise | clean and seamless, but the material is a **different material** |
| Pixel maths only (warp + flat-field) | faithful, but the user recognised it as **"no different from straightening the photo in Photoshop"** |
| Step 1 on a photo that is **already** a flat texture | throws away exactly the wanted detail (formwork seams, aggregate, staining) and replaces it with generic speckle, 26 s slower. This is what `mode="direct"` exists for — see the first section |

### What the model actually takes from the reference (ablation)

`ReferenceLatent` feeds the photo in as conditioning, so step 1 is NOT pure
text-to-image. But it is not an equal partner either. Measured with
`scripts/reference-ablation.mjs` (same prompt, same seed, 384px, 16 steps):

| run | reference | prompt names the colour | colourful mean RGB |
|---|---|---|---|
| A | orange-red can | no | (0.85, 0.76, 0.60) pale cream |
| B | pale yellow can | no | (0.77, 0.71, 0.58) pale cream |
| C | none (plain txt2img) | no | (0.72, 0.65, 0.53) pale cream |
| real run | orange-red can | yes, "orange-red" | (0.78, 0.35, 0.21) **orange** |

Read it as two separate findings:

1. **The photo is consumed** - A, B and C all differ (mean abs diff 0.07-0.11, and
   A even picked up the rusty edge band the orange can has). The reference drives
   *structure, pattern, wear and edge artefacts*.
2. **Colour does NOT reliably come from the photo.** An orange-red reference with
   a colour-free prompt produced pale cream - the model fell back to its prior.
   Colour comes from the PROMPT.

That is exactly why the two-stage design exists, and why the colour-match step is
not optional: step 1 supplies shape, the prompt supplies colour, and step 2 then
pulls the palette back onto the photo's real paint pixels (hue-masked mean, e.g.
25171 pixels averaging RGB (0.4817, 0.3183, 0.2695) against the reference's own
(0.461, 0.310, 0.267) - it lands on the reference, not on a guess).

Practical consequence: **a material description without a colour is a weak
description.** When you write one, always name the colour.

img2img preserves the input's spatial composition by construction. You cannot change
the layout without either doing it by maths (which the user rejects - it makes the
model pointless) or raising denoise (which swaps in the model's prior). An
**instruction-edit model** is the mechanism that changes structure while keeping
identity. That is why step 1 exists.

## How to run it here

| Tool | Use |
|---|---|
| `pbr_comfy_status` | Is the install / python / model library / pbrlab pack / run root ready? Which ComfyUI instance is up? How much VRAM is free? |
| `pbr_material_from_photo` | The whole pipeline. One call, minutes, returns the map paths plus tile metrics. |
| `pbr_check_maps` | Measure + preview any existing map set, however it was produced. |

There is also a **GUI workbench** (sidebar → `PBR 材质`) with two separate boxes,
and the distinction matters:

- **② 你的需求** is what the user *means*, in their own language. It is not a prompt.
- **③ 给生图模型的材质描述** is the one English line FLUX gets.

One button hands ② plus the reference photo to a vision model through DSH's own
`llm` service and writes ③; pressing 生成 with ③ empty does that first and then
runs the pipeline. So when the user says "I made one in the panel", the run still
happened — read the output directory rather than assuming nothing ran. The drafted
line and the model that wrote it are in the job log and in `manifest.json`.

If the user asks you to write ③ for them, do what the panel does: look at the
photo, then produce ONE paragraph of colour + substrate + wear, naming the neutral
areas the colour-match step must leave alone.

**Output layout: one folder per material set**, named by the studio convention
when a category/name/version is given (`T_<category>_<name>_<NN>/`), otherwise by
job slug. Inside it the maps carry the convention suffixes (`_C _N _R _AO _M _H
_CURV`) plus the packed companions (`_CA`, `_CH`, `_NRM`), while `manifest.json`
and a `preview/` folder (reference copy + 3x3 tiling previews) sit alongside.
So a finished run is a self-describing, engine-ready folder — when the user asks
"where did it go", point at the folder, not at individual files.

The plugin attaches to an already-running ComfyUI; only when none answers does it
start its own headless instance (port 8288) and stop it again when the job ends.
That is deliberate: 16 GB cannot hold two copies of Klein 4B plus its text encoder.

`material` is the one parameter that decides whether the result is a real material or
generic AI texture. Give colour + substrate + wear, in English:
`"heavily worn pale yellow-cream paint on metal, large flakes chipped off revealing dark brown and black bare metal underneath, fine scratches, dust and grime, matte aged finish"`.

## Step 1 - the edit graph

Node signatures here were read from `comfy_extras` source, not guessed:

```
UNETLoader        flux-2-klein-base-4b-fp8.safetensors, weight_dtype=default
CLIPLoader        qwen_3_4b.safetensors, type="flux2", device=default
VAELoader         flux2-vae.safetensors
LoadImage         <reference photo>
ImageScaleToTotalPixels  upscale_method=lanczos, megapixels=1.0, resolution_steps=1
VAEEncode         pixels=scaled ref, vae                  # the reference latent
CLIPTextEncode    positive / negative
ReferenceLatent   conditioning=positive, latent=VAEEncode  -> CFGGuider.positive
ReferenceLatent   conditioning=negative, latent=VAEEncode  -> CFGGuider.negative
CFGGuider         model=UNET, positive, negative, cfg=5.0  -> GUIDER
Flux2Scheduler    steps=20, width, height                  -> SIGMAS   (no model input)
KSamplerSelect    sampler_name=euler                       -> SAMPLER
EmptyFlux2LatentImage  width=1024, height=1024, batch_size=1
RandomNoise       noise_seed                               -> NOISE
SamplerCustomAdvanced  noise, guider, sampler, sigmas, latent_image -> LATENT
VAEDecode         samples, vae                             -> IMAGE
SaveImage
```

Facts that cost time to learn:

- `ReferenceLatent` (`comfy_extras/nodes_edit_model.py`) is **the** mechanism: it
  writes `reference_latents` into the conditioning. Chain several for multi-reference.
- `CLIPLoader`'s `type` **must be `"flux2"`** for this model family.
- `Flux2Scheduler` takes `steps/width/height` and has **no model input**.
- `SamplerCustomAdvanced` returns `(output, denoised_output)` - take index 0.
- A 4B model at fp8 is ~4 GB on disk and about 8.4 GB of VRAM - it fits a 16 GB card
  comfortably, which the 20B alternatives do not.

### The prompt is the control

Structure it in this order; every clause below is load-bearing and was measured:

1. **The view first.** `flat ORTHOGRAPHIC FRONT VIEW ... the surface plane parallel
   to the image plane, camera exactly perpendicular, no perspective, no
   foreshortening, no vanishing point.`
2. **Remove all object structure.** `no ridges, no embossed X, no seams, no rivets,
   no edges, no silhouette, no handle, no cap, no background, no shadow.`
3. **Keep the material identity.** `Keep the material identity exactly: <colour and
   material + what the wear looks like>.`
4. **Force small, uniform features.** `Uniform, finely and evenly spread chip
   density, many small chips rather than a few large ones.`
5. Negative: `perspective, foreshortening, oblique angle, object, container, handle,
   cap, ridge, edges, silhouette, background, ground, shadow, highlight, vignette,
   text, watermark, border, few large patches, single dominant feature, gradient`

**Never write `macro photograph` or `close-up`.** Measured: that wording makes the
model return one small patch filling the frame - a user described it as "it turned my
field into a single brick". Describe the AREA SCALE you want instead ("a wide expanse
... many small chips").

Clause 4 is not cosmetic: it also reduces the visible cost of step 2 (see below).

## Step 2 - deterministic, in this order

Order matters; a step that can break periodicity must run before the tiling step.

```
1. hue-selective colour match   (optional, to pull the palette to the reference)
2. MakeSeamless                 (tile it)
3. PBRSynth                     (derive normal/height/roughness/AO/curvature/metallic)
4. Save 16-bit                  (height / normal / AO at minimum)
```

### Colour match must be hue-selective

A per-channel (Reinhard) transfer applied globally **tints neutral elements**. Real
failure: a chrome/grey paint chip area turned **cyan** because the reference palette
was warm and the per-channel gain raised blue on the neutral pixels.

Do it in HSV with a saturation gate (`python/hue_colormatch.py`, default mode):

```python
w = clip((S - 0.18) / 0.12, 0, 1)        # soft mask: only colourful pixels
w = w[..., None] * strength
out = src * (1 - w) + recoloured * w     # neutrals (bare metal, white chips) untouched
```

Rotate hue along the shortest circular path to the target paint hue; scale S and V by
the ratio of the target paint's mean S/V. **Sweep strength** - 1.0 overshoots (orange-red
became dark red-brown); **~0.6** matched the reference.

`color_match: "reinhard"` still exists (it is `PBRLabColorMatch` in-graph) because the
failure is instructive, not because it is a good default.

### Estimate the reference colour with a hue mask, never by hand-picking a crop

Hand-picking a "pure paint" patch framed the object's frame/shadow and produced a wrong
target. Mask the reference by hue instead, e.g. for orange-red
`H in [5°, 35°], S >= 0.25, V >= 0.10`, then average those pixels. This found 25125
paint pixels on a 230x242 reference and produced a correct target. Override the hue
window through the plugin config for other palettes.

### The tiling cost is a function of feature size

`MakeSeamless` blends opposite edges, which is a **local mirror symmetry** - inherent to
the operator, not tunable away. Measured: it is far less visible when the material's
features are small and evenly spread. That is why the step-1 prompt asks for
`many small chips rather than a few large ones`: same material, and the seam stops
reading as an artefact. Verify by tiling 2x2 and looking, not just by the number -
`pbr_check_maps` writes the 3x3 preview for exactly this.

## Hard limits - state these to the user instead of trying harder

- **Output resolution is capped by the reference's usable material area.**
  Rule of thumb from measurement: keep `output / source_side <= ~1.6`. Up to 3x is
  borderline; beyond that the model invents most of the detail and it reads as "AI".
- **A photo of an object whose flat surface occupies only ~100 px cannot yield a
  faithful 512 tile.** If the reference has a big embossed feature (a ridge, a label,
  a frame) crossing most of the surface, say so and ask for a closer photo of a flat
  area, rather than shipping something that looks like a different material.
- Tiling gives `wrap_ratio 0.00` (the metric passes) while a 2x2 view can still show
  the mirror seam. Both are true; report both.

## Where things live

**Nothing about the machine is hard-coded any more.** Paths are discovered, and
the report always says where each came from:

```
ComfyUI   环境变量 PBR_MATERIAL_COMFY_DIR → %APPDATA%\Comfy Desktop\comfy-procs\inst-*.json
          （里面的 installPath 与 port 是 Comfy Desktop 自己写的）→ 常见位置兜底
模型库     PBR_MATERIAL_MODELS_DIR → instance-model-paths\inst-*.yaml 的 base_path（权威）
python    PBR_MATERIAL_PYTHON → <install>\.venv\Scripts\python.exe → PATH
run root  config.json 的 comfy.runRoot → 默认 %LOCALAPPDATA%\dsh-pbr-material\comfy_root
节点包    插件自带 assets/pbrlab，自动链进 run root 的 custom_nodes\pbrlab
```

The plugin never writes into the user's ComfyUI: it runs its own instance against
its own run root, with only `comfy_extras` linked from the install.

Weights: 3 files, ~12.5 GB, downloaded by `pbr_setup_install` from URLs read out
of ComfyUI's own blueprint (`blueprints/Image Edit (Flux.2 Klein 4B).json`), with
a mirror fallback and `.part` resume. `pbr_setup_status` reports what is missing
and `probe_speed=true` projects the download time. Never start a 12.5 GB download
without telling the user how long it will take.

**Historical probes.** `assets/` keeps the scripts the original research ran
(`klein_edit_probe.py`, `hue_selective_colormatch.py`, `klein_variants_probe.py`,
`clash_switch.py`, `download_recommended.py`). They document how the numbers in
this file were obtained, and **several still assume the author's machine** —
`download_recommended.py` in particular downloads an OLD model set that this
pipeline does not use, and refuses to run without an explicit `--models-root`.
For anything real, use the plugin: `pbr_setup_status` / `pbr_setup_install` to
deploy, `pbr_material_from_photo` to generate. `python/hue_colormatch.py` is the
supported CLI form of the colour-match algorithm.

### Run it headless by hand (the plugin does this for you)

Take the paths from `pbr_setup_status` — nothing below is fixed to one machine:

```powershell
$py   = "<python from pbr_setup_status>"          # e.g. <ComfyUI>\.venv\Scripts\python.exe
$c    = "<installDir from pbr_setup_status>"      # the directory holding main.py
$root = "<runRoot from pbr_setup_status>"         # the plugin's own base-directory
& $py -B "$c\main.py" --port 8288 --listen 127.0.0.1 --base-directory $root `
   --extra-model-paths-config "$root\extra_model_paths.yaml" --disable-auto-launch --log-stdout
```

- Port **8288**: `8164-8263` are Windows-reserved and fail with `WinError 10013`.
- Put the reference at `$root\input\<name>.png`; outputs land in `$root\output\pbrlab\`.
- `$root\custom_nodes\pbrlab` is a junction to the plugin's `assets/pbrlab`, created
  automatically. If ComfyUI is reinstalled, `comfy_extras` becomes a dead link and
  `main.py` dies with `FileNotFoundError: custom_extras` — `ensureRunRoot` re-points
  it, and reports what it repaired.
- **Stop the process when done.** It holds ~5 GB of weights and competes with the
  user's desktop instance.
- `/history` stores only SaveImage images, never STRING outputs - verify by measuring
  the written files.

## Node-level traps in this pack (all measured)

- `PBRLabCircularVAEPad` is valid **only for an EMPTY latent**. Applied to a
  VAE-encoded latent it turns the sample into a kaleidoscope. Padding zeroes also
  cannot make generation seamless at all, because the sampler generates its own noise;
  make the NOISE periodic if you ever need that, and note that FLUX is not
  translation-equivariant so periodic noise produces a repeating frame instead.
- When cropping away a latent pad, the image-space offset is `pad * 8` (pad is in
  latent units).
- `PBRLabDetailTransfer`: `mode=soft` is required. Plain `replace` blanks regions where
  the source is flat (measured: flat-region high-frequency 0.109 -> 0.010, visible as a
  smooth pale blob). `radius` selects which scale is restored - 3 restores grain only,
  8-16 restores cracks.
- `PBRLabSaveImage16` with `grayscale=False` for normal maps; `grayscale=True` would
  discard the X/Y components and silently produce a useless map.
- Roughness/metallic honesty: albedo/normal/height are **generated**, rough/AO/curvature
  are **derived**, metallic is **yours to state**. A single 2D image contains no
  metallic information; guessing it from albedo yields inverted masks.

## Working method that paid off repeatedly

1. **Run it yourself and look at the output image.** Do not iterate from the user's
   description alone.
2. **Read the user's real files off disk.** Inputs sit in
   `D:\Comfy-Desktop\ComfyUI-Shared\input\pasted\`, outputs in
   `...\output\pbrlab\`. Reproducing measurements on those beats any replica.
3. **When a numeric metric looks good but the user says it is wrong, trust the user
   and look at the image.** Measured case: "structure retention 0.91" while the model
   had reorganised all the chips into a rectangular outline.
4. **When the proxy is slow, test node throughput, not just latency.** A node with the
   lowest latency (43 ms) delivered 0.00 MB/s while a 52 ms node delivered 4.16 MB/s.
   `tools\clash_switch.py --test` measures this through Clash Verge's named pipe.
5. **Scripts and metrics have bugs too.** A rounded expected size turned a complete
   download into "incomplete", and the retry then hit HTTP 416 five times. Verify with
   the exact `Content-Length`, and read the downloaded file back.
