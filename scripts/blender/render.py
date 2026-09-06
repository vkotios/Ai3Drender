"""Headless Blender/Cycles render worker for ai3drender.

Invoked by `lib/pipeline/render.ts` as:

    blender -b -noaudio --python-exit-code 1 --python render.py -- \
        --scene <scene.glb> --params <params.json> --out <output dir>

`scene.glb` is a *complete* glTF scene assembled server-side by
`lib/render/build-scene.ts`: every furniture piece, prop, light and the
camera are already positioned nodes in it (furniture meshes carried over
byte-for-byte from the reconstruction stage's own glTF output; lights via the
KHR_lights_punctual extension; the camera as a standard glTF camera node).
Blender's own glTF importer (`io_scene_gltf2`, bundled with Blender) turns all
of that into real Blender objects in one call, including the Y-up -> Z-up
axis conversion - this script does not need to reimplement any of that math.

`params.json` carries the render-only settings that are NOT part of the scene
graph: output resolution, sample count, denoising, requested extra passes,
and the handful of EnvironmentSettings fields (background colour, HDRI/
ambient intensity) that describe the *world*, not a piece of geometry glTF
can encode.

Known, deliberate simplification: `EnvironmentSettings.hdriPreset` selects a
bundled HDRI drei/three.js loads client-side (e.g. "studio", "apartment") for
image-based lighting. Those files are not available on the render worker, so
this script does not attempt to reproduce IBL - it sets a flat-colour Cycles
world background at a brightness derived from `hdriIntensity`/
`ambientIntensity` instead. Wiring a real .hdr per preset (an HDRI_DIR of
matching files shipped to the worker) is a natural follow-up; the `params`
schema already carries everything needed to add it without changing the
calling convention.
"""

import glob
import json
import os
import sys
import traceback

import bpy


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = argv[1:]

    args = {}
    key = None
    for token in argv:
        if token.startswith("--"):
            key = token[2:]
            args[key] = True  # bare flag unless a value follows
        elif key is not None:
            args[key] = token
            key = None
    return args


def srgb_hex_to_linear(hex_color):
    """'#rrggbb' -> (r, g, b) linear floats. Blender's world colour is linear, same as glTF baseColorFactor."""
    h = (hex_color or "#999999").lstrip("#")
    if len(h) != 6:
        h = "999999"
    r, g, b = (int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))

    def to_linear(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return to_linear(r), to_linear(g), to_linear(b)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_scene(path):
    bpy.ops.import_scene.gltf(filepath=path)


def find_camera():
    for obj in bpy.data.objects:
        if obj.type == "CAMERA":
            return obj
    return None


def setup_world(params):
    """Flat-colour Cycles world standing in for the HDRI the browser uses. See module docstring."""
    env = params.get("environment", {})
    world = bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is None:
        return
    r, g, b = srgb_hex_to_linear(env.get("backgroundColorHex", "#EDEBE6"))
    bg.inputs[0].default_value = (r, g, b, 1.0)
    # No physical basis for this number - see module docstring. Floors out at
    # a low but non-zero value so a scene with hdriIntensity ~= 0 is still lit.
    strength = 0.25 + float(env.get("hdriIntensity", 1.0)) * 0.5 + float(env.get("ambientIntensity", 0.3)) * 0.5
    bg.inputs[1].default_value = max(0.05, strength)


def setup_device(requested):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    if requested != "GPU":
        return
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.refresh_devices()
        enabled = False
        for backend in ("OPTIX", "CUDA", "HIP", "METAL"):
            prefs.compute_device_type = backend
            devices = [d for d in prefs.devices if d.type == backend]
            if devices:
                for d in devices:
                    d.use = True
                scene.cycles.device = "GPU"
                enabled = True
                break
        if not enabled:
            print("WARNING: BLENDER_DEVICE=GPU requested but no Cycles GPU backend was found; using CPU.")
    except Exception as cause:  # noqa: BLE001 - this is a best-effort opt-in, never worth failing the render for.
        print(f"WARNING: could not enable a Cycles GPU device ({cause}); using CPU.")


def setup_passes(view_layer, requested, out_dir, image_format):
    """Best-effort: wires Cycles view-layer passes to compositor File Output nodes.

    Returns the list of passes actually wired (a pass whose render-layer output
    socket does not exist under this Blender version is skipped with a
    warning rather than failing the whole render - cryptomatte's socket name
    in particular has changed across Blender releases).
    """
    scene = bpy.context.scene
    scene.use_nodes = True
    tree = scene.node_tree
    tree.nodes.clear()
    render_layers = tree.nodes.new("CompositorNodeRLayers")
    composite = tree.nodes.new("CompositorNodeComposite")
    tree.links.new(render_layers.outputs["Image"], composite.inputs["Image"])

    wired = []
    socket_for_pass = {}
    if "ao" in requested:
        view_layer.use_pass_ambient_occlusion = True
        socket_for_pass["ao"] = "AO"
    if "cryptomatte" in requested:
        view_layer.use_pass_cryptomatte_object = True
        # Socket name has varied across Blender releases; try the modern name first.
        socket_for_pass["cryptomatte"] = None  # resolved below, once the socket actually exists

    for pass_name, socket_name in socket_for_pass.items():
        candidates = [socket_name] if socket_name else ["CryptoObject00", "CryptoObject"]
        found = next((c for c in candidates if c in render_layers.outputs), None)
        if not found:
            print(f"WARNING: render pass '{pass_name}' has no matching output on this Blender build; skipping.")
            continue
        output = tree.nodes.new("CompositorNodeOutputFile")
        output.base_path = out_dir
        output.format.file_format = "OPEN_EXR" if image_format == "exr" else "PNG"
        output.file_slots[0].path = f"{pass_name}_"
        tree.links.new(render_layers.outputs[found], output.inputs[0])
        wired.append(pass_name)

    return wired


def render_beauty(out_dir, image_format):
    scene = bpy.context.scene
    ext = "exr" if image_format == "exr" else "png"
    scene.render.image_settings.file_format = "OPEN_EXR" if ext == "exr" else "PNG"
    scene.render.filepath = os.path.join(out_dir, f"beauty.{ext}")
    # Exact filename, no Blender-appended frame number - see module docstring.
    scene.render.use_file_extension = False

    try:
        bpy.ops.render.render(write_still=True)
        denoised = scene.cycles.use_denoising
    except RuntimeError as cause:
        message = str(cause)
        if scene.cycles.use_denoising and "denois" in message.lower():
            # Some Blender builds (notably distro packages built without OIDN)
            # cannot denoise at all and raise instead of silently skipping it.
            print(f"WARNING: denoising unavailable on this Blender build ({message}); re-rendering without it.")
            scene.cycles.use_denoising = False
            bpy.ops.render.render(write_still=True)
            denoised = False
        else:
            raise

    return f"beauty.{ext}", denoised


def find_pass_file(out_dir, pass_name):
    matches = sorted(glob.glob(os.path.join(out_dir, f"{pass_name}_*")))
    return os.path.basename(matches[-1]) if matches else None


def main():
    args = parse_args()
    scene_path = args["scene"]
    with open(args["params"], "r", encoding="utf-8") as f:
        params = json.load(f)
    out_dir = args["out"]
    os.makedirs(out_dir, exist_ok=True)

    reset_scene()
    import_scene(scene_path)

    camera = find_camera()
    if camera is None:
        raise RuntimeError("imported scene has no camera")
    bpy.context.scene.camera = camera

    setup_world(params)
    setup_device(params.get("device", "CPU"))

    scene = bpy.context.scene
    scene.render.resolution_x = int(params["width"])
    scene.render.resolution_y = int(params["height"])
    scene.render.resolution_percentage = 100
    scene.cycles.samples = int(params["samples"])
    scene.cycles.use_denoising = bool(params.get("denoise", True))

    image_format = params.get("format", "png")
    requested_passes = params.get("passes") or []
    wired_passes = (
        setup_passes(bpy.context.view_layer, requested_passes, out_dir, image_format) if requested_passes else []
    )

    beauty_file, denoised = render_beauty(out_dir, image_format)

    pass_files = {}
    for pass_name in wired_passes:
        filename = find_pass_file(out_dir, pass_name)
        if filename:
            pass_files[pass_name] = filename
        else:
            print(f"WARNING: pass '{pass_name}' was wired but produced no output file.")

    result = {
        "beauty": beauty_file,
        "passes": pass_files,
        "denoised": denoised,
        "samples": scene.cycles.samples,
    }
    # The one line lib/pipeline/render.ts actually parses; everything else on
    # stdout is Blender's own progress logging.
    print(f"RENDER_RESULT {json.dumps(result)}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
