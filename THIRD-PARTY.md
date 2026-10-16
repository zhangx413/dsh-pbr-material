# Third-party and scope notes

`LICENSE` covers this repository's own code (MIT). Two things it deliberately
does **not** cover:

## 1. Model weights are not in this repository

`pbr_setup_install` downloads three files (~12.5 GB) from HuggingFace / hf-mirror:

| file | upstream | size |
|---|---|---|
| `flux-2-klein-base-4b-fp8.safetensors` | `black-forest-labs/FLUX.2-klein-base-4b-fp8` | 4.09 GB |
| `qwen_3_4b.safetensors` | `Comfy-Org/z_image_turbo` (split_files/text_encoders) | 8.04 GB |
| `flux2-vae.safetensors` | `Comfy-Org/flux2-dev` (split_files/vae) | 0.34 GB |

Those URLs were read out of ComfyUI's own blueprint
(`blueprints/Image Edit (Flux.2 Klein 4B).json`, `properties.models`), not chosen
by hand. **Each model carries its own licence** — FLUX.2 Klein and Qwen3 are not
blanket-permissive. Check them yourself before any commercial use; this project
only fetches the files.

## 2. `assets/pbrlab/`

The ComfyUI node pack in `assets/` (MakeSeamless, PBRSynth, TileValidator, …) is
part of this project and is covered by the MIT licence above.

## 3. `skill/assets/` is historical

Those scripts are the probes the original research ran; they document how the
numbers in `skill/SKILL.md` were measured. Several still assume the author's
machine. `download_recommended.py` in particular fetches an **old** model set
that the current pipeline does not use, and refuses to run without an explicit
`--models-root`. The supported paths are the plugin's tools:
`pbr_setup_status`, `pbr_setup_install`, `pbr_material_from_photo`.
