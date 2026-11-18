"""Headless Blender 5.2 generator for Chroma Strike's KAY/O Combat Android.

Run from the `chroma-strike` project root:
    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --python scripts\\blender\\build_kayo_agent.py

Outputs:
    public/models/agent_kayo.glb

Coordinate Convention:
    All geometry is authored directly in Three.js joint-local space:
      +X = character right (-X = character left)
      +Y = up (-Y = limb extension direction from joint pivot 0,0,0)
      -Z = forward (visor, chest, kneecaps, boot toes)
      +Z = back (spine hydraulics, dorsal kits, heels)

    Before writing to Blender meshes, vertices and object locations are rotated
    by Rx(+90 deg): (tx, ty, tz) -> (tx, -tz, ty). Blender's glTF 2.0 exporter
    with `export_yup=True` applies Rx(-90 deg), yielding exact Three.js local
    joint coordinates with determinant +1 (outward normals preserved).

Bone Proportions (matched exactly to `src/entities/characterModel.ts`):
    HIP_Y / WAIST_Y = 0.880 m   | HIP_X = +-0.130 m
    THIGH_LEN       = 0.400 m   | KNEE_TO_SOLE = 0.480 m  (sole at world y = 0.000 m)
    SHOULDER_Y      = 1.320 m   | SHOULDER_X   = +-0.240 m
    UPPER_ARM_LEN   = 0.300 m   | FOREARM_LEN  = 0.290 m  (hand centre at y = -0.290 m)
    HEAD_CENTER_Y   = 1.600 m   | NECK_Y       = 1.465 m  (mounted in headGroup at y = -0.135 m)
"""

import json
import math
import os
import struct
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

# ---------------------------------------------------------------------------
# Three.js <-> Blender coordinate transform: Rx(+90 deg)
# Maps Three.js (tx, ty, tz) -> Blender (tx, -tz, ty); det = +1.
# ---------------------------------------------------------------------------
M_T2B = Matrix.Rotation(math.pi * 0.5, 4, "X")

# Exact anatomical constants from src/entities/characterModel.ts
WAIST_Y = 0.88
HIP_X = 0.13
HIP_Y = 0.88
THIGH_LEN = 0.40
KNEE_TO_SOLE = 0.48
SHOULDER_X = 0.24
SHOULDER_Y = 1.32
UPPER_ARM_LEN = 0.30
FOREARM_LEN = 0.29
NECK_Y = 1.465  # Head local origin; mounted inside headGroup (world y=1.60) at local y=-0.135

# Material slot indices (fixed across every object for consistent multi-material export)
MAT_ARMOR_PRIMARY = 0
MAT_ARMOR_SECONDARY = 1
MAT_VISOR_LED = 2
MAT_CHASSIS_DARK = 3
MAT_JOINT_METAL = 4
MAT_TEAM_STRIPE = 5

MATERIAL_NAMES = [
    "Mat_ArmorPrimary",
    "Mat_ArmorSecondary",
    "Mat_VisorLED",
    "Mat_ChassisDark",
    "Mat_JointMetal",
    "Mat_TeamStripe",
]


def clear_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def create_pbr_material(
    name: str,
    base_color: tuple[float, float, float, float],
    metallic: float,
    roughness: float,
    emission_color: tuple[float, float, float, float] | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = nt.nodes.new(type="ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = base_color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission_color is not None and emission_strength > 0.0:
        bsdf.inputs["Emission Color"].default_value = emission_color
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def build_materials() -> list[bpy.types.Material]:
    return [
        create_pbr_material(
            "Mat_ArmorPrimary",
            base_color=(0.04, 0.72, 0.96, 1.0),
            metallic=0.38,
            roughness=0.34,
            emission_color=(0.04, 0.72, 0.96, 1.0),
            emission_strength=0.15,
        ),
        create_pbr_material(
            "Mat_ArmorSecondary",
            base_color=(0.24, 0.28, 0.35, 1.0),
            metallic=0.58,
            roughness=0.36,
        ),
        create_pbr_material(
            "Mat_VisorLED",
            base_color=(0.20, 0.92, 1.0, 1.0),
            metallic=0.05,
            roughness=0.14,
            emission_color=(0.12, 0.90, 1.0, 1.0),
            emission_strength=2.2,
        ),
        create_pbr_material(
            "Mat_ChassisDark",
            base_color=(0.11, 0.13, 0.18, 1.0),
            metallic=0.32,
            roughness=0.52,
        ),
        create_pbr_material(
            "Mat_JointMetal",
            base_color=(0.44, 0.49, 0.56, 1.0),
            metallic=0.84,
            roughness=0.26,
        ),
        create_pbr_material(
            "Mat_TeamStripe",
            base_color=(0.86, 0.90, 0.96, 1.0),
            metallic=0.22,
            roughness=0.32,
        ),
    ]


# ---------------------------------------------------------------------------
# BMesh sculptural primitives (all authored in Three.js joint-local space)
# ---------------------------------------------------------------------------
def _append_sub(
    dst: bmesh.types.BMesh,
    src: bmesh.types.BMesh,
    mat_idx: int,
    smooth: bool = False,
    smooth_side_only: bool = False,
) -> None:
    bmesh.ops.recalc_face_normals(src, faces=list(src.faces))
    src.verts.index_update()
    vmap = [dst.verts.new(v.co) for v in src.verts]
    for f in src.faces:
        try:
            nf = dst.faces.new([vmap[v.index] for v in f.verts])
            nf.material_index = mat_idx
            if smooth_side_only:
                nf.smooth = len(f.verts) == 4
            else:
                nf.smooth = smooth
        except ValueError:
            pass
    src.free()


def _euler_mat(rot: tuple[float, float, float]) -> Matrix:
    return Euler(rot, "XYZ").to_matrix().to_4x4()


def add_box(
    bm: bmesh.types.BMesh,
    center: tuple[float, float, float],
    size: tuple[float, float, float],
    mat_idx: int,
    bevel: float = 0.0,
    rot: tuple[float, float, float] = (0.0, 0.0, 0.0),
    bevel_segs: int = 1,
    smooth: bool = False,
) -> None:
    sub = bmesh.new()
    bmesh.ops.create_cube(sub, size=1.0)
    scale_m = Matrix.Diagonal((size[0], size[1], size[2], 1.0))
    bmesh.ops.transform(sub, matrix=scale_m, verts=sub.verts)
    # Skip expensive edge bevels on tiny trim bars (<16mm) to keep poly budget lean
    if bevel > 1e-5 and min(size) >= 0.016:
        max_b = min(size) * 0.40
        b_amt = min(bevel, max_b)
        bmesh.ops.bevel(
            sub,
            geom=list(sub.edges),
            offset=b_amt,
            segments=bevel_segs,
            profile=0.5,
            affect="EDGES",
            clamp_overlap=True,
        )
    xform = Matrix.Translation(Vector(center)) @ _euler_mat(rot)
    bmesh.ops.transform(sub, matrix=xform, verts=sub.verts)
    _append_sub(bm, sub, mat_idx, smooth=smooth)


def add_cylinder(
    bm: bmesh.types.BMesh,
    p0: tuple[float, float, float],
    p1: tuple[float, float, float],
    r0: float,
    r1: float,
    mat_idx: int,
    segs: int = 10,
    cap: bool = True,
    smooth: bool = True,
) -> None:
    v0 = Vector(p0)
    v1 = Vector(p1)
    delta = v1 - v0
    length = delta.length
    if length < 1e-5:
        return
    sub = bmesh.new()
    bmesh.ops.create_cone(
        sub,
        cap_ends=cap,
        cap_tris=False,
        segments=segs,
        radius1=r0,
        radius2=r1,
        depth=length,
    )
    # create_cone runs along local Z from -length/2 to +length/2
    z_axis = Vector((0.0, 0.0, 1.0))
    quat = z_axis.rotation_difference(delta.normalized())
    mid = (v0 + v1) * 0.5
    xform = Matrix.Translation(mid) @ quat.to_matrix().to_4x4()
    bmesh.ops.transform(sub, matrix=xform, verts=sub.verts)
    _append_sub(bm, sub, mat_idx, smooth=smooth, smooth_side_only=smooth)


def add_sphere(
    bm: bmesh.types.BMesh,
    center: tuple[float, float, float],
    radii: tuple[float, float, float] | float,
    mat_idx: int,
    segs: int = 10,
    rings: int = 6,
    rot: tuple[float, float, float] = (0.0, 0.0, 0.0),
    smooth: bool = True,
) -> None:
    if isinstance(radii, (int, float)):
        rx = ry = rz = float(radii)
    else:
        rx, ry, rz = radii
    sub = bmesh.new()
    bmesh.ops.create_uvsphere(sub, u_segments=segs, v_segments=rings, radius=1.0)
    scale_m = Matrix.Diagonal((rx, ry, rz, 1.0))
    xform = Matrix.Translation(Vector(center)) @ _euler_mat(rot) @ scale_m
    bmesh.ops.transform(sub, matrix=xform, verts=sub.verts)
    _append_sub(bm, sub, mat_idx, smooth=smooth)


def add_octahedron(
    bm: bmesh.types.BMesh,
    center: tuple[float, float, float],
    radii: tuple[float, float, float],
    mat_idx: int,
    rot: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> None:
    rx, ry, rz = radii
    sub = bmesh.new()
    pts = [
        Vector((0.0, ry, 0.0)),
        Vector((0.0, -ry, 0.0)),
        Vector((rx, 0.0, 0.0)),
        Vector((0.0, 0.0, -rz)),
        Vector((-rx, 0.0, 0.0)),
        Vector((0.0, 0.0, rz)),
    ]
    vs = [sub.verts.new(p) for p in pts]
    ring = [2, 3, 4, 5]
    for i in range(4):
        a = ring[i]
        b = ring[(i + 1) % 4]
        sub.faces.new([vs[0], vs[a], vs[b]])
        sub.faces.new([vs[1], vs[b], vs[a]])
    xform = Matrix.Translation(Vector(center)) @ _euler_mat(rot)
    bmesh.ops.transform(sub, matrix=xform, verts=sub.verts)
    _append_sub(bm, sub, mat_idx, smooth=False)


def add_loft(
    bm: bmesh.types.BMesh,
    rings: list[list[tuple[float, float, float]]],
    mat_idx: int,
    cap_start: bool = True,
    cap_end: bool = True,
    smooth: bool = False,
) -> None:
    """Builds a closed lofted armor shell across a sequence of equal-length 3D rings."""
    if len(rings) < 2:
        return
    n = len(rings[0])
    sub = bmesh.new()
    v_rings = [[sub.verts.new(Vector(p)) for p in ring] for ring in rings]
    for r_idx in range(len(v_rings) - 1):
        r0 = v_rings[r_idx]
        r1 = v_rings[r_idx + 1]
        for i in range(n):
            j = (i + 1) % n
            sub.faces.new([r0[i], r0[j], r1[j], r1[i]])
    if cap_start:
        sub.faces.new(list(reversed(v_rings[0])))
    if cap_end:
        sub.faces.new(list(v_rings[-1]))
    _append_sub(bm, sub, mat_idx, smooth=smooth, smooth_side_only=smooth)


def chamfer_rect_ring(
    y: float,
    hw: float,
    hd_front: float,
    hd_back: float,
    cf: float,
    cb: float,
    x_shift: float = 0.0,
    z_shift: float = 0.0,
) -> list[tuple[float, float, float]]:
    """8-vertex chamfered octagonal cross-section in XZ at height y (-Z = front, +Z = back)."""
    cf = min(cf, hw * 0.85, hd_front * 0.85)
    cb = min(cb, hw * 0.85, hd_back * 0.85)
    z_f = -hd_front + z_shift
    z_b = hd_back + z_shift
    return [
        (x_shift - hw + cf, y, z_f),
        (x_shift + hw - cf, y, z_f),
        (x_shift + hw, y, z_f + cf),
        (x_shift + hw, y, z_b - cb),
        (x_shift + hw - cb, y, z_b),
        (x_shift - hw + cb, y, z_b),
        (x_shift - hw, y, z_b - cb),
        (x_shift - hw, y, z_f + cf),
    ]


def add_prism(
    bm: bmesh.types.BMesh,
    poly_2d: list[tuple[float, float]],
    thickness: float,
    center: tuple[float, float, float],
    mat_idx: int,
    rot: tuple[float, float, float] = (0.0, 0.0, 0.0),
    bevel: float = 0.0,
    plane: str = "YZ",
) -> None:
    """Extrudes a 2D polygon into a beveled armor plate / fin.

    plane='YZ': poly points are (z, y), extruded along X.
    plane='XY': poly points are (x, y), extruded along Z.
    plane='XZ': poly points are (x, z), extruded along Y.
    """
    ht = thickness * 0.5
    sub = bmesh.new()

    def to3(u: float, v: float, w: float) -> Vector:
        if plane == "YZ":
            return Vector((w, v, u))
        if plane == "XY":
            return Vector((u, v, w))
        return Vector((u, w, v))

    v_neg = [sub.verts.new(to3(u, v, -ht)) for (u, v) in poly_2d]
    v_pos = [sub.verts.new(to3(u, v, +ht)) for (u, v) in poly_2d]
    n = len(poly_2d)
    sub.faces.new(list(reversed(v_neg)))
    sub.faces.new(v_pos)
    for i in range(n):
        j = (i + 1) % n
        sub.faces.new([v_neg[i], v_neg[j], v_pos[j], v_pos[i]])
    if bevel > 1e-5:
        bmesh.ops.bevel(
            sub,
            geom=list(sub.edges),
            offset=min(bevel, ht * 0.75),
            segments=1,
            profile=0.5,
            affect="EDGES",
            clamp_overlap=True,
        )
    xform = Matrix.Translation(Vector(center)) @ _euler_mat(rot)
    bmesh.ops.transform(sub, matrix=xform, verts=sub.verts)
    _append_sub(bm, sub, mat_idx, smooth=False)


def add_torus(
    bm: bmesh.types.BMesh,
    center: tuple[float, float, float],
    major_r: float,
    minor_r: float,
    mat_idx: int,
    major_segs: int = 16,
    minor_segs: int = 6,
    rot: tuple[float, float, float] = (0.0, 0.0, 0.0),
    smooth: bool = True,
) -> None:
    """Torus lying in the XZ plane (around Y axis) before applying `rot`."""
    sub = bmesh.new()
    rings: list[list[bmesh.types.BMVert]] = []
    for i in range(major_segs):
        theta = (i / major_segs) * math.tau
        ct, st = math.cos(theta), math.sin(theta)
        ring = []
        for j in range(minor_segs):
            phi = (j / minor_segs) * math.tau
            cp, sp = math.cos(phi), math.sin(phi)
            r = major_r + minor_r * cp
            ring.append(sub.verts.new(Vector((r * ct, minor_r * sp, r * st))))
        rings.append(ring)
    for i in range(major_segs):
        r0 = rings[i]
        r1 = rings[(i + 1) % major_segs]
        for j in range(minor_segs):
            jn = (j + 1) % minor_segs
            sub.faces.new([r0[j], r1[j], r1[jn], r0[jn]])
    xform = Matrix.Translation(Vector(center)) @ _euler_mat(rot)
    bmesh.ops.transform(sub, matrix=xform, verts=sub.verts)
    _append_sub(bm, sub, mat_idx, smooth=smooth)


# ---------------------------------------------------------------------------
# Mesh finalization (Three.js -> Blender transform, EdgeSplit, material slots)
# ---------------------------------------------------------------------------
def finalize_object(
    name: str,
    bm: bmesh.types.BMesh,
    materials: list[bpy.types.Material],
    world_three_pos: tuple[float, float, float],
) -> bpy.types.Object:
    bmesh.ops.transform(bm, matrix=M_T2B, verts=bm.verts)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()

    for mat in materials:
        mesh.materials.append(mat)
    mesh.update()

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = M_T2B @ Vector(world_three_pos)

    # Split sharp hard-surface edges (>38 deg) so chamfers stay razor crisp while
    # curved hydraulics / spheres stay smooth on export_apply=True.
    mod = obj.modifiers.new(name="EdgeSplit", type="EDGE_SPLIT")
    mod.use_edge_angle = True
    mod.split_angle = math.radians(38.0)
    return obj


# ===========================================================================
# 1. KAY/O PELVIS (origin at hip y = 0, assembled at (0, HIP_Y, 0))
# ===========================================================================
def build_kayo_pelvis(materials: list[bpy.types.Material]) -> bpy.types.Object:
    bm = bmesh.new()

    # Core pelvic chassis block (connects waist to hip sockets)
    pelvis_rings = [
        chamfer_rect_ring(-0.138, 0.052, 0.068, 0.062, 0.018, 0.018),
        chamfer_rect_ring(-0.070, 0.128, 0.095, 0.092, 0.028, 0.026),
        chamfer_rect_ring(0.005, 0.148, 0.106, 0.102, 0.032, 0.030),
        chamfer_rect_ring(0.048, 0.140, 0.098, 0.095, 0.030, 0.028),
    ]
    add_loft(bm, pelvis_rings, MAT_CHASSIS_DARK)

    # Heavy angular front codpiece / pelvic armor plate
    cod_rings = [
        chamfer_rect_ring(-0.145, 0.046, 0.096, 0.045, 0.016, 0.014, z_shift=-0.018),
        chamfer_rect_ring(-0.062, 0.088, 0.118, 0.055, 0.024, 0.016, z_shift=-0.012),
        chamfer_rect_ring(0.015, 0.112, 0.114, 0.050, 0.028, 0.015, z_shift=-0.005),
    ]
    add_loft(bm, cod_rings, MAT_ARMOR_PRIMARY)
    add_box(bm, (0.0, -0.075, -0.116), (0.070, 0.095, 0.024), MAT_ARMOR_SECONDARY, bevel=0.006, rot=(0.14, 0.0, 0.0))

    # Rear glute armor shield
    add_box(bm, (0.0, -0.042, 0.096), (0.205, 0.118, 0.038), MAT_ARMOR_PRIMARY, bevel=0.010, rot=(-0.08, 0.0, 0.0))
    add_box(bm, (0.0, -0.030, 0.112), (0.068, 0.088, 0.018), MAT_ARMOR_SECONDARY, bevel=0.005)

    # Tactical belt collar & glowing center telemetry buckle
    belt_rings = [
        chamfer_rect_ring(0.006, 0.160, 0.114, 0.110, 0.034, 0.032),
        chamfer_rect_ring(0.052, 0.158, 0.112, 0.108, 0.034, 0.032),
    ]
    add_loft(bm, belt_rings, MAT_CHASSIS_DARK)
    add_box(bm, (0.0, 0.026, -0.116), (0.074, 0.046, 0.020), MAT_ARMOR_SECONDARY, bevel=0.005)
    add_box(bm, (0.0, 0.026, -0.126), (0.042, 0.016, 0.008), MAT_VISOR_LED, bevel=0.002)

    # Lateral armored hip skirt plates, team stripes, and utility mag pouches
    for side in (-1.0, 1.0):
        # Hip axle shaft extending cleanly into left/right thigh origins (+-HIP_X)
        add_cylinder(bm, (side * 0.06, 0.0, 0.0), (side * (HIP_X + 0.015), 0.0, 0.0), 0.036, 0.032, MAT_JOINT_METAL, segs=10)
        # Angled lateral hip tasset plate
        add_box(
            bm,
            (side * 0.162, -0.036, -0.004),
            (0.026, 0.118, 0.128),
            MAT_ARMOR_PRIMARY,
            bevel=0.007,
            rot=(0.0, 0.0, -side * 0.14),
        )
        add_box(
            bm,
            (side * 0.175, -0.030, -0.010),
            (0.008, 0.072, 0.030),
            MAT_TEAM_STRIPE,
            bevel=0.0,
            rot=(0.0, 0.0, -side * 0.14),
        )
        # Compact angled tactical pouches on front-side & rear-side belt
        add_box(bm, (side * 0.112, 0.018, -0.104), (0.048, 0.062, 0.032), MAT_ARMOR_SECONDARY, bevel=0.0, rot=(0.0, -side * 0.42, 0.0))
        add_box(bm, (side * 0.105, 0.016, 0.104), (0.056, 0.058, 0.034), MAT_ARMOR_SECONDARY, bevel=0.0, rot=(0.0, side * 0.35, 0.0))

    return finalize_object("Kayo_Pelvis", bm, materials, (0.0, HIP_Y, 0.0))


# ===========================================================================
# 2. KAY/O TORSO (origin at waist y = 0, assembled at (0, WAIST_Y, 0))
#    Up to ~0.50 m chest/collar + neck column to ~0.585 m (world 1.465 m)
# ===========================================================================
def build_kayo_torso(materials: list[bpy.types.Material]) -> bpy.types.Object:
    bm = bmesh.new()

    # --- Articulated V-taper inner robotic abdomen & ribcage chassis ---
    ab_rings = [
        chamfer_rect_ring(-0.025, 0.128, 0.092, 0.088, 0.028, 0.028),
        chamfer_rect_ring(0.060, 0.134, 0.096, 0.092, 0.030, 0.030),
        chamfer_rect_ring(0.175, 0.158, 0.112, 0.102, 0.036, 0.034),
        chamfer_rect_ring(0.320, 0.194, 0.132, 0.112, 0.044, 0.038),
        chamfer_rect_ring(0.455, 0.188, 0.120, 0.105, 0.044, 0.038),
        chamfer_rect_ring(0.500, 0.118, 0.088, 0.084, 0.032, 0.030),
    ]
    add_loft(bm, ab_rings, MAT_CHASSIS_DARK)

    # 3 layered angular abdominal armor plates on front (-Z)
    for y_ab, w_ab, z_ab in ((0.040, 0.155, -0.098), (0.092, 0.172, -0.106), (0.145, 0.192, -0.115)):
        add_box(bm, (0.0, y_ab, z_ab), (w_ab, 0.042, 0.026), MAT_ARMOR_PRIMARY, bevel=0.0, rot=(-0.10, 0.0, 0.0))
        add_box(bm, (0.0, y_ab, z_ab - 0.010), (0.044, 0.032, 0.012), MAT_ARMOR_SECONDARY, bevel=0.0, rot=(-0.10, 0.0, 0.0))

    # Dual angled oblique waist hydraulic pistons + lateral rib vents
    for side in (-1.0, 1.0):
        add_cylinder(bm, (side * 0.122, 0.015, -0.045), (side * 0.155, 0.195, -0.055), 0.013, 0.013, MAT_JOINT_METAL, segs=6)
        add_cylinder(bm, (side * 0.126, 0.020, 0.048), (side * 0.158, 0.200, 0.042), 0.014, 0.014, MAT_JOINT_METAL, segs=6)
        # Rib louver vents on lower chest flanks
        for vy in (0.195, 0.232, 0.268):
            add_box(bm, (side * 0.182, vy, -0.028), (0.032, 0.022, 0.095), MAT_ARMOR_SECONDARY, bevel=0.0, rot=(0.0, -side * 0.18, side * 0.22))
            add_box(bm, (side * 0.197, vy, -0.028), (0.008, 0.010, 0.074), MAT_JOINT_METAL, bevel=0.0, rot=(0.0, -side * 0.18, side * 0.22))

    # --- Iconic KAY/O Angular Chest Carapace ---
    # Upper main carapace shell
    chest_rings = [
        chamfer_rect_ring(0.185, 0.164, 0.126, 0.108, 0.038, 0.032),
        chamfer_rect_ring(0.285, 0.214, 0.152, 0.120, 0.048, 0.038),
        chamfer_rect_ring(0.410, 0.222, 0.148, 0.118, 0.052, 0.040),
        chamfer_rect_ring(0.488, 0.168, 0.106, 0.100, 0.042, 0.036),
    ]
    add_loft(bm, chest_rings, MAT_ARMOR_PRIMARY)

    # Sculpted split angular pectoral armor slabs (canted boldly forward)
    for side in (-1.0, 1.0):
        add_box(
            bm,
            (side * 0.106, 0.345, -0.132),
            (0.142, 0.165, 0.052),
            MAT_ARMOR_PRIMARY,
            bevel=0.014,
            rot=(-0.10, -side * 0.28, side * 0.10),
        )
        # Clavicle armor strap arching from sternum to shoulder mount
        add_box(
            bm,
            (side * 0.132, 0.455, -0.072),
            (0.118, 0.052, 0.090),
            MAT_ARMOR_SECONDARY,
            bevel=0.0,
            rot=(0.24, -side * 0.16, -side * 0.22),
        )
        # Crisp chest team-contrast tactical chevron stripe
        add_box(
            bm,
            (side * 0.116, 0.398, -0.145),
            (0.095, 0.022, 0.014),
            MAT_TEAM_STRIPE,
            bevel=0.0,
            rot=(-0.10, -side * 0.28, -side * 0.16),
        )

    # --- Recessed Hexagonal Chest Reactor Core ---
    add_box(bm, (0.0, 0.340, -0.150), (0.088, 0.096, 0.030), MAT_ARMOR_SECONDARY, bevel=0.014)
    add_box(bm, (0.0, 0.340, -0.162), (0.056, 0.062, 0.014), MAT_CHASSIS_DARK, bevel=0.0)
    add_octahedron(bm, (0.0, 0.340, -0.166), (0.026, 0.030, 0.012), MAT_VISOR_LED)

    # --- Dorsal Spine Hydraulics & Scapula Kit Mounts (+Z back) ---
    # Articulated spinal vertebrae blocks
    for i, y_sp in enumerate((0.06, 0.135, 0.210, 0.285, 0.365)):
        w_sp = 0.058 + i * 0.005
        z_sp = 0.106 + (0.012 if i >= 2 else 0.0)
        add_box(bm, (0.0, y_sp, z_sp), (w_sp, 0.052, 0.036), MAT_ARMOR_SECONDARY, bevel=0.0)
    for side in (-1.0, 1.0):
        # Twin dorsal hydraulic stabilizer struts
        add_cylinder(bm, (side * 0.062, 0.075, 0.106), (side * 0.098, 0.385, 0.120), 0.015, 0.012, MAT_JOINT_METAL, segs=6)
        # Upper scapula armor plates & dorsal kit latch rail
        add_box(bm, (side * 0.110, 0.355, 0.112), (0.118, 0.165, 0.040), MAT_ARMOR_PRIMARY, bevel=0.008, rot=(0.06, side * 0.22, -side * 0.08))
        add_box(bm, (side * 0.072, 0.300, 0.128), (0.028, 0.190, 0.018), MAT_JOINT_METAL, bevel=0.0)

    # --- High Armored Tactical Collar Gorget & Hydraulic Neck Column ---
    collar_rings = [
        chamfer_rect_ring(0.468, 0.112, 0.096, 0.098, 0.034, 0.034),
        chamfer_rect_ring(0.528, 0.096, 0.088, 0.096, 0.030, 0.030),
    ]
    add_loft(bm, collar_rings, MAT_ARMOR_SECONDARY)
    # Rear high collar shield behind neck
    add_box(bm, (0.0, 0.515, 0.076), (0.140, 0.064, 0.036), MAT_ARMOR_PRIMARY, bevel=0.008, rot=(-0.22, 0.0, 0.0))
    add_box(bm, (0.0, 0.506, -0.084), (0.108, 0.022, 0.020), MAT_TEAM_STRIPE, bevel=0.0, rot=(0.25, 0.0, 0.0))
    # Mechanical neck column & front hydraulic tendons (extends up to y=0.585 -> world 1.465)
    add_cylinder(bm, (0.0, 0.475, 0.0), (0.0, 0.592, 0.0), 0.054, 0.048, MAT_CHASSIS_DARK, segs=10)
    for side in (-1.0, 1.0):
        add_cylinder(bm, (side * 0.042, 0.480, -0.032), (side * 0.030, 0.588, -0.018), 0.011, 0.009, MAT_JOINT_METAL, segs=6)
        add_cylinder(bm, (side * 0.036, 0.485, 0.034), (side * 0.028, 0.588, 0.024), 0.012, 0.010, MAT_JOINT_METAL, segs=6)

    # --- Heavy Angular Shoulder Pauldron Mounts (frame shoulders at x=+-0.24, y=0.44) ---
    for side in (-1.0, 1.0):
        # Machined shoulder socket collar & hinge yoke
        add_cylinder(bm, (side * 0.165, 0.440, 0.0), (side * 0.240, 0.440, 0.0), 0.044, 0.040, MAT_JOINT_METAL, segs=8)
        # Main faceted pauldron carapace arching over shoulder joint
        add_box(
            bm,
            (side * 0.252, 0.484, -0.002),
            (0.118, 0.072, 0.158),
            MAT_ARMOR_PRIMARY,
            bevel=0.014,
            rot=(0.0, 0.0, -side * 0.34),
        )
        # Outer tiered armor brow plate
        add_box(
            bm,
            (side * 0.285, 0.454, -0.004),
            (0.058, 0.088, 0.132),
            MAT_ARMOR_SECONDARY,
            bevel=0.0,
            rot=(0.0, 0.0, -side * 0.16),
        )
        # High-contrast team stripe along upper pauldron ridge
        add_box(
            bm,
            (side * 0.258, 0.514, -0.002),
            (0.068, 0.016, 0.126),
            MAT_TEAM_STRIPE,
            bevel=0.0,
            rot=(0.0, 0.0, -side * 0.34),
        )

    return finalize_object("Kayo_Torso", bm, materials, (0.0, WAIST_Y, 0.0))


# ===========================================================================
# 3. KAY/O HEAD (origin at neck y = 0, height ~0.27 m + antennae to 0.315 m)
#    Assembled at world (0, NECK_Y=1.465, 0); mounted in headGroup at y=-0.135
#    so visor center lands dead-on HEAD_CENTER_Y = 1.600 m!
# ===========================================================================
def build_kayo_head(materials: list[bpy.types.Material]) -> bpy.types.Object:
    bm = bmesh.new()

    # Neck ball-socket gimbal plug (seats cleanly inside torso neck column)
    add_sphere(bm, (0.0, 0.008, 0.0), (0.048, 0.036, 0.048), MAT_JOINT_METAL, segs=12, rings=8)

    # --- Iconic KAY/O Chamfered Rectangular Combat-Bot Helmet Shell ---
    head_rings = [
        chamfer_rect_ring(0.018, 0.076, 0.104, 0.090, 0.024, 0.024, z_shift=-0.006),
        chamfer_rect_ring(0.078, 0.098, 0.118, 0.110, 0.026, 0.028, z_shift=-0.004),
        chamfer_rect_ring(0.205, 0.106, 0.122, 0.124, 0.026, 0.030, z_shift=0.002),
        chamfer_rect_ring(0.258, 0.094, 0.108, 0.114, 0.028, 0.030, z_shift=0.006),
        chamfer_rect_ring(0.272, 0.064, 0.078, 0.088, 0.020, 0.022, z_shift=0.008),
    ]
    add_loft(bm, head_rings, MAT_ARMOR_PRIMARY)

    # Raised central crown armor ridge + forehead chevron stripe
    add_box(bm, (0.0, 0.258, 0.006), (0.066, 0.032, 0.195), MAT_ARMOR_SECONDARY, bevel=0.008)
    add_box(bm, (0.0, 0.274, -0.020), (0.036, 0.010, 0.125), MAT_TEAM_STRIPE, bevel=0.002)
    # Rear occipital battery/vent plate
    add_box(bm, (0.0, 0.150, 0.120), (0.125, 0.125, 0.026), MAT_ARMOR_SECONDARY, bevel=0.007, rot=(-0.08, 0.0, 0.0))
    add_box(bm, (0.0, 0.155, 0.132), (0.058, 0.022, 0.010), MAT_VISOR_LED, bevel=0.002)

    # Fierce overhanging angular brow hood above the visor
    add_box(bm, (0.0, 0.222, -0.118), (0.186, 0.036, 0.048), MAT_ARMOR_PRIMARY, bevel=0.008, rot=(0.18, 0.0, 0.0))
    add_box(bm, (0.0, 0.236, -0.122), (0.136, 0.012, 0.016), MAT_TEAM_STRIPE, bevel=0.002, rot=(0.18, 0.0, 0.0))

    # --- Recessed Slanted Visor Bezel + Glowing KAY/O Mat_VisorLED Faceplate ---
    # Dark outer visor frame bezel
    add_box(bm, (0.0, 0.145, -0.114), (0.174, 0.124, 0.026), MAT_CHASSIS_DARK, bevel=0.0, rot=(-0.10, 0.0, 0.0))
    # Angled cheek armor guards framing the left/right edges of the visor screen
    for side in (-1.0, 1.0):
        add_box(
            bm,
            (side * 0.094, 0.132, -0.098),
            (0.032, 0.140, 0.068),
            MAT_ARMOR_PRIMARY,
            bevel=0.007,
            rot=(0.0, -side * 0.14, -side * 0.06),
        )
    # Bright recessed slanted LED display screen (iconic KAY/O glowing face!)
    add_box(bm, (0.0, 0.146, -0.124), (0.148, 0.096, 0.010), MAT_VISOR_LED, bevel=0.0, rot=(-0.10, 0.0, 0.0))
    # Thin horizontal dark-bezel divider bar across lower visor edge for crisp tech framing
    add_box(bm, (0.0, 0.092, -0.122), (0.156, 0.014, 0.018), MAT_ARMOR_SECONDARY, bevel=0.0, rot=(-0.10, 0.0, 0.0))

    # --- Jaw Armor & Breather Vent Grille ---
    add_box(bm, (0.0, 0.046, -0.104), (0.126, 0.062, 0.042), MAT_ARMOR_SECONDARY, bevel=0.008, rot=(0.14, 0.0, 0.0))
    # 3 recessed horizontal chin grille slats
    for gy in (0.030, 0.046, 0.062):
        add_box(bm, (0.0, gy, -0.124), (0.076, 0.007, 0.010), MAT_CHASSIS_DARK, bevel=0.0, rot=(0.14, 0.0, 0.0))
    # Chin guard side ribs
    for side in (-1.0, 1.0):
        add_box(bm, (side * 0.062, 0.052, -0.092), (0.026, 0.048, 0.052), MAT_ARMOR_PRIMARY, bevel=0.0, rot=(0.0, -side * 0.25, 0.0))

    # --- Dual Mechanical Ear Comm-Pods & Swept Tactical Antennae ---
    for side in (-1.0, 1.0):
        # Ear hub housing
        add_cylinder(
            bm,
            (side * 0.096, 0.142, 0.008),
            (side * 0.126, 0.142, 0.008),
            0.042,
            0.034,
            MAT_ARMOR_SECONDARY,
            segs=8,
        )
        add_cylinder(
            bm,
            (side * 0.122, 0.142, 0.008),
            (side * 0.132, 0.142, 0.008),
            0.022,
            0.020,
            MAT_JOINT_METAL,
            segs=8,
        )
        # Small glowing comm LED dot on each ear pod
        add_cylinder(
            bm,
            (side * 0.129, 0.142, 0.008),
            (side * 0.135, 0.142, 0.008),
            0.010,
            0.010,
            MAT_VISOR_LED,
            segs=6,
        )
        # Swept-back tactical ear antenna (asymmetric right slightly taller)
        tip_y = 0.315 if side > 0 else 0.295
        add_box(bm, (side * 0.114, 0.195, 0.036), (0.014, 0.068, 0.022), MAT_CHASSIS_DARK, bevel=0.0, rot=(0.24, 0.0, -side * 0.08))
        add_cylinder(
            bm,
            (side * 0.116, 0.215, 0.044),
            (side * 0.124, tip_y, 0.074),
            0.007,
            0.0035,
            MAT_JOINT_METAL,
            segs=6,
        )

    return finalize_object("Kayo_Head", bm, materials, (0.0, NECK_Y, 0.0))


# ===========================================================================
# 4. KAY/O UPPER ARMS (origin = shoulder 0,0,0; elbow at y = -UPPER_ARM_LEN = -0.30)
# ===========================================================================
def build_kayo_upper_arm(side: float, name: str, materials: list[bpy.types.Material]) -> bpy.types.Object:
    bm = bmesh.new()

    # Spherical machined titanium shoulder actuator ball at origin (0,0,0)
    add_sphere(bm, (0.0, 0.0, 0.0), (0.052, 0.052, 0.052), MAT_JOINT_METAL, segs=12, rings=8)

    # Inner mechanical humerus core running down to elbow (-0.30)
    humerus_rings = [
        chamfer_rect_ring(-0.020, 0.044, 0.044, 0.044, 0.014, 0.014),
        chamfer_rect_ring(-0.150, 0.042, 0.044, 0.042, 0.014, 0.014),
        chamfer_rect_ring(-0.285, 0.036, 0.038, 0.038, 0.012, 0.012),
    ]
    add_loft(bm, humerus_rings, MAT_CHASSIS_DARK)

    # Outer deltoid + bicep angular armor shell (on lateral side*X)
    bicep_rings = [
        chamfer_rect_ring(-0.010, 0.054, 0.052, 0.050, 0.016, 0.016, x_shift=side * 0.012),
        chamfer_rect_ring(-0.125, 0.058, 0.054, 0.050, 0.016, 0.016, x_shift=side * 0.014),
        chamfer_rect_ring(-0.245, 0.046, 0.045, 0.044, 0.014, 0.014, x_shift=side * 0.008),
    ]
    add_loft(bm, bicep_rings, MAT_ARMOR_PRIMARY)

    # Lateral beveled armor shield + team contrast stripe
    add_box(bm, (side * 0.064, -0.118, -0.004), (0.022, 0.165, 0.068), MAT_ARMOR_SECONDARY, bevel=0.005, rot=(0.0, 0.0, -side * 0.06))
    add_box(bm, (side * 0.075, -0.115, -0.006), (0.008, 0.105, 0.022), MAT_TEAM_STRIPE, bevel=0.002, rot=(0.0, 0.0, -side * 0.06))

    # Front hydraulic bicep rod & elbow clevis pin at y = -UPPER_ARM_LEN
    add_cylinder(bm, (side * 0.014, -0.035, -0.046), (side * 0.010, -0.275, -0.038), 0.010, 0.009, MAT_JOINT_METAL, segs=8)
    add_cylinder(bm, (-0.046, -UPPER_ARM_LEN, 0.0), (0.046, -UPPER_ARM_LEN, 0.0), 0.030, 0.030, MAT_JOINT_METAL, segs=12)

    return finalize_object(name, bm, materials, (side * SHOULDER_X, SHOULDER_Y, 0.0))


# ===========================================================================
# 5. KAY/O FOREARMS + MECHANICAL HANDS (origin = elbow 0,0,0; hand at -FOREARM_LEN=-0.29)
# ===========================================================================
def build_kayo_forearm(side: float, name: str, materials: list[bpy.types.Material]) -> bpy.types.Object:
    bm = bmesh.new()

    # Elbow actuator hub & angular rear olecranon elbow guard (+Z)
    add_sphere(bm, (0.0, 0.0, 0.0), (0.040, 0.040, 0.042), MAT_JOINT_METAL, segs=10, rings=8)
    add_box(bm, (0.0, -0.012, 0.042), (0.062, 0.074, 0.028), MAT_ARMOR_SECONDARY, bevel=0.007, rot=(0.18, 0.0, 0.0))

    # Inner dark titanium ulna/radius core
    inner_rings = [
        chamfer_rect_ring(-0.010, 0.038, 0.038, 0.038, 0.012, 0.012),
        chamfer_rect_ring(-0.125, 0.036, 0.038, 0.038, 0.012, 0.012),
        chamfer_rect_ring(-0.242, 0.028, 0.030, 0.030, 0.010, 0.010),
    ]
    add_loft(bm, inner_rings, MAT_CHASSIS_DARK)

    # Tapered angular Agent-colored forearm gauntlet carapace
    gauntlet_rings = [
        chamfer_rect_ring(-0.024, 0.052, 0.048, 0.054, 0.015, 0.016, x_shift=side * 0.005),
        chamfer_rect_ring(-0.130, 0.048, 0.046, 0.050, 0.014, 0.015, x_shift=side * 0.004),
        chamfer_rect_ring(-0.228, 0.040, 0.038, 0.042, 0.012, 0.012, x_shift=side * 0.003),
    ]
    add_loft(bm, gauntlet_rings, MAT_ARMOR_PRIMARY)

    # Outer dorsal forearm blade ridge + team stripe cuff + glowing LED wrist telemetry bars
    add_box(bm, (side * 0.044, -0.125, 0.014), (0.022, 0.175, 0.046), MAT_ARMOR_SECONDARY, bevel=0.005)
    add_box(bm, (side * 0.054, -0.125, 0.014), (0.007, 0.120, 0.014), MAT_TEAM_STRIPE, bevel=0.002)
    # Twin glowing wrist status LED bars (matching 1P KAY/O mechanical hands!)
    add_box(bm, (side * 0.036, -0.205, -0.026), (0.010, 0.036, 0.008), MAT_VISOR_LED, bevel=0.001)
    add_box(bm, (side * 0.022, -0.205, -0.034), (0.010, 0.036, 0.008), MAT_VISOR_LED, bevel=0.001)

    # Mechanical wrist gimbal cuff at y = -0.245
    add_cylinder(bm, (0.0, -0.232, 0.0), (0.0, -0.258, 0.0), 0.028, 0.026, MAT_JOINT_METAL, segs=10)

    # Articulated mechanical android hand centered at y = -FOREARM_LEN (-0.290)
    # Dark titanium palm chassis + beveled back-of-hand armor plate
    add_box(bm, (0.0, -0.285, 0.0), (0.046, 0.054, 0.060), MAT_CHASSIS_DARK, bevel=0.005)
    add_box(bm, (side * 0.024, -0.282, 0.002), (0.014, 0.048, 0.052), MAT_ARMOR_SECONDARY, bevel=0.0)
    # Beveled knuckle bar + curled segmented mechanical finger cluster
    add_box(bm, (side * 0.004, -0.314, -0.012), (0.044, 0.016, 0.048), MAT_JOINT_METAL, bevel=0.0)
    add_box(bm, (-side * 0.006, -0.324, -0.018), (0.042, 0.020, 0.038), MAT_CHASSIS_DARK, bevel=0.0, rot=(0.25, 0.0, 0.0))
    # Opposable mechanical thumb on front-inner edge
    add_box(bm, (-side * 0.022, -0.282, -0.034), (0.020, 0.034, 0.024), MAT_JOINT_METAL, bevel=0.0, rot=(-0.30, side * 0.25, 0.0))

    return finalize_object(name, bm, materials, (side * SHOULDER_X, SHOULDER_Y - UPPER_ARM_LEN, 0.0))


# ===========================================================================
# 6. KAY/O THIGHS (origin = hip 0,0,0; knee at y = -THIGH_LEN = -0.400)
# ===========================================================================
def build_kayo_thigh(side: float, name: str, materials: list[bpy.types.Material]) -> bpy.types.Object:
    bm = bmesh.new()

    # Hip ball-joint actuator housing at origin
    add_sphere(bm, (0.0, 0.0, 0.0), (0.068, 0.064, 0.068), MAT_JOINT_METAL, segs=12, rings=8)

    # Dark inner femur endoskeleton shaft
    femur_rings = [
        chamfer_rect_ring(0.015, 0.064, 0.068, 0.068, 0.020, 0.020),
        chamfer_rect_ring(-0.180, 0.058, 0.064, 0.064, 0.018, 0.018),
        chamfer_rect_ring(-0.390, 0.048, 0.052, 0.052, 0.016, 0.016),
    ]
    add_loft(bm, femur_rings, MAT_CHASSIS_DARK)

    # Sculpted muscular front & lateral quadriceps armor shell
    quad_rings = [
        chamfer_rect_ring(-0.010, 0.078, 0.088, 0.066, 0.024, 0.020, x_shift=side * 0.010, z_shift=-0.008),
        chamfer_rect_ring(-0.145, 0.082, 0.092, 0.068, 0.026, 0.020, x_shift=side * 0.012, z_shift=-0.010),
        chamfer_rect_ring(-0.345, 0.062, 0.072, 0.056, 0.020, 0.018, x_shift=side * 0.006, z_shift=-0.006),
    ]
    add_loft(bm, quad_rings, MAT_ARMOR_PRIMARY)

    # Outer lateral thigh tactical armor plate + bold vertical team stripe
    add_box(bm, (side * 0.084, -0.175, -0.004), (0.026, 0.250, 0.095), MAT_ARMOR_SECONDARY, bevel=0.007, rot=(0.0, 0.0, -side * 0.05))
    add_box(bm, (side * 0.097, -0.175, -0.008), (0.008, 0.190, 0.026), MAT_TEAM_STRIPE, bevel=0.002, rot=(0.0, 0.0, -side * 0.05))

    # Rear hamstring hydraulic piston & knee axle cylinder at y = -THIGH_LEN (-0.400)
    add_cylinder(bm, (side * 0.024, -0.055, 0.066), (side * 0.020, -0.370, 0.052), 0.014, 0.012, MAT_JOINT_METAL, segs=8)
    add_cylinder(bm, (-0.056, -THIGH_LEN, 0.0), (0.056, -THIGH_LEN, 0.0), 0.038, 0.038, MAT_JOINT_METAL, segs=12)

    return finalize_object(name, bm, materials, (side * HIP_X, HIP_Y, 0.0))


# ===========================================================================
# 7. KAY/O SHINS + TACTICAL BOOTS (origin = knee 0,0,0; boot sole EXACTLY at -0.480)
# ===========================================================================
def build_kayo_shin(side: float, name: str, materials: list[bpy.types.Material]) -> bpy.types.Object:
    bm = bmesh.new()

    # Heavy beveled hexagonal armored knee guard on front (-Z)
    add_box(bm, (0.0, 0.004, -0.060), (0.096, 0.106, 0.044), MAT_ARMOR_PRIMARY, bevel=0.014, rot=(0.10, 0.0, 0.0))
    add_box(bm, (0.0, 0.006, -0.078), (0.054, 0.068, 0.020), MAT_ARMOR_SECONDARY, bevel=0.007, rot=(0.10, 0.0, 0.0))
    # Lateral knee hinge pivot caps
    add_cylinder(bm, (-0.062, 0.0, 0.0), (0.062, 0.0, 0.0), 0.032, 0.032, MAT_JOINT_METAL, segs=10)

    # Dark inner tibia chassis column (knee -> ankle)
    tibia_rings = [
        chamfer_rect_ring(-0.020, 0.050, 0.054, 0.058, 0.016, 0.016),
        chamfer_rect_ring(-0.180, 0.046, 0.050, 0.062, 0.014, 0.016),
        chamfer_rect_ring(-0.375, 0.038, 0.042, 0.044, 0.012, 0.012),
    ]
    add_loft(bm, tibia_rings, MAT_CHASSIS_DARK)

    # Forward angular shin greave armor (crisp KAY/O armored lower leg!)
    greave_rings = [
        chamfer_rect_ring(-0.052, 0.064, 0.078, 0.044, 0.022, 0.016, z_shift=-0.012),
        chamfer_rect_ring(-0.185, 0.060, 0.074, 0.048, 0.020, 0.016, z_shift=-0.010),
        chamfer_rect_ring(-0.365, 0.050, 0.064, 0.042, 0.016, 0.014, z_shift=-0.008),
    ]
    add_loft(bm, greave_rings, MAT_ARMOR_PRIMARY)

    # Lateral shin team stripe & rear calf hydraulic damper piston + calf cowling
    add_box(bm, (side * 0.060, -0.205, -0.014), (0.010, 0.215, 0.026), MAT_TEAM_STRIPE, bevel=0.002)
    add_box(bm, (0.0, -0.155, 0.064), (0.082, 0.165, 0.036), MAT_ARMOR_SECONDARY, bevel=0.010, rot=(-0.10, 0.0, 0.0))
    add_cylinder(bm, (0.0, -0.065, 0.074), (0.0, -0.395, 0.058), 0.015, 0.012, MAT_JOINT_METAL, segs=8)

    # Articulated mechanical ankle servo cuff (y = -0.385..-0.420)
    add_cylinder(bm, (-0.054, -0.398, -0.004), (0.054, -0.398, -0.004), 0.026, 0.026, MAT_JOINT_METAL, segs=10)
    add_box(bm, (0.0, -0.392, 0.004), (0.086, 0.046, 0.086), MAT_CHASSIS_DARK, bevel=0.008)

    # --- Heavy Armored Combat Boot (flat sole resting EXACTLY at y = -KNEE_TO_SOLE = -0.480) ---
    sole_bottom = -KNEE_TO_SOLE  # -0.480
    sole_top = sole_bottom + 0.030  # -0.450
    # Flat traction sole base (guaranteed bottom == -0.480)
    sole_rings = [
        chamfer_rect_ring(sole_bottom, 0.066, 0.162, 0.088, 0.024, 0.020),
        chamfer_rect_ring(sole_top, 0.070, 0.166, 0.090, 0.024, 0.020),
    ]
    add_loft(bm, sole_rings, MAT_CHASSIS_DARK)

    # Faceted armored boot vamp & sloped toe cap (-Z forward)
    boot_rings = [
        chamfer_rect_ring(sole_top, 0.068, 0.160, 0.084, 0.024, 0.020),
        chamfer_rect_ring(sole_top + 0.036, 0.064, 0.132, 0.078, 0.022, 0.018),
        chamfer_rect_ring(sole_top + 0.068, 0.054, 0.076, 0.068, 0.018, 0.016),
    ]
    add_loft(bm, boot_rings, MAT_ARMOR_PRIMARY)

    # Reinforced front toe bumper & rear heel stabilizer block + tiny ankle LED strip
    add_box(bm, (0.0, sole_top + 0.016, -0.148), (0.098, 0.032, 0.036), MAT_ARMOR_SECONDARY, bevel=0.0, rot=(0.24, 0.0, 0.0))
    add_box(bm, (0.0, sole_top + 0.024, 0.080), (0.096, 0.048, 0.030), MAT_ARMOR_SECONDARY, bevel=0.0)
    add_box(bm, (side * 0.058, -0.414, -0.020), (0.010, 0.014, 0.044), MAT_VISOR_LED, bevel=0.0)

    return finalize_object(name, bm, materials, (side * HIP_X, HIP_Y - THIGH_LEN, 0.0))


# ===========================================================================
# 8. FIVE DISTINCT AGENT DORSAL KITS (waist origin 0,0,0 -> mounted on upperBody)
#    All sit cleanly on torso back (+Z = 0.115..0.24) clearing Spike & head!
# ===========================================================================
def build_kit_red(materials: list[bpy.types.Material]) -> bpy.types.Object:
    """BLAZE (Red) — Incendiary Jump-Thrusters: twin canted jet pods, plasma nozzles, swept winglets."""
    bm = bmesh.new()

    # Central dorsal manifold spine block
    add_box(bm, (0.0, 0.305, 0.145), (0.110, 0.215, 0.068), MAT_ARMOR_SECONDARY, bevel=0.010)
    add_box(bm, (0.0, 0.335, 0.180), (0.046, 0.110, 0.016), MAT_VISOR_LED, bevel=0.003)

    wing_poly = [(0.0, 0.0), (0.135, 0.115), (0.155, 0.085), (0.045, -0.055)]
    for side in (-1.0, 1.0):
        # Angled armored jump-thruster nacelle
        add_box(
            bm,
            (side * 0.098, 0.335, 0.168),
            (0.082, 0.195, 0.092),
            MAT_ARMOR_PRIMARY,
            bevel=0.014,
            rot=(-0.18, side * 0.14, -side * 0.16),
        )
        # Upper intake cowling lip
        add_box(
            bm,
            (side * 0.108, 0.430, 0.156),
            (0.068, 0.042, 0.076),
            MAT_CHASSIS_DARK,
            bevel=0.006,
            rot=(-0.18, side * 0.14, -side * 0.16),
        )
        # Downward-swept metallic thruster bell + glowing incendiary plasma core
        add_cylinder(
            bm,
            (side * 0.092, 0.245, 0.186),
            (side * 0.118, 0.162, 0.214),
            0.032,
            0.044,
            MAT_JOINT_METAL,
            segs=12,
        )
        add_cylinder(
            bm,
            (side * 0.113, 0.175, 0.210),
            (side * 0.120, 0.156, 0.217),
            0.028,
            0.034,
            MAT_VISOR_LED,
            segs=10,
        )
        # Swept stabilizer winglet with team stripe accent
        add_prism(
            bm,
            wing_poly,
            0.014,
            (side * 0.122, 0.415, 0.150),
            MAT_ARMOR_PRIMARY,
            rot=(0.0, side * 0.42, -side * 0.28),
            bevel=0.003,
            plane="YZ",
        )
        add_box(
            bm,
            (side * 0.135, 0.345, 0.206),
            (0.012, 0.125, 0.022),
            MAT_TEAM_STRIPE,
            bevel=0.002,
            rot=(-0.18, side * 0.14, -side * 0.16),
        )

    return finalize_object("Kit_Red", bm, materials, (0.0, WAIST_Y, 0.0))


def build_kit_blue(materials: list[bpy.types.Material]) -> bpy.types.Object:
    """MIST (Blue) — Vertical Cryo Tanks + Cross-Manifold + Coolant Lines."""
    bm = bmesh.new()

    # Backplate mounting frame + upper horizontal manifold bridge
    add_box(bm, (0.0, 0.295, 0.132), (0.175, 0.235, 0.032), MAT_CHASSIS_DARK, bevel=0.0)
    add_cylinder(bm, (-0.092, 0.448, 0.172), (0.092, 0.448, 0.172), 0.020, 0.020, MAT_JOINT_METAL, segs=8)
    # Central cryogenic pressure regulator valve + glowing dial
    add_box(bm, (0.0, 0.448, 0.180), (0.056, 0.056, 0.048), MAT_ARMOR_SECONDARY, bevel=0.007)
    add_cylinder(bm, (0.0, 0.448, 0.198), (0.0, 0.448, 0.212), 0.018, 0.018, MAT_VISOR_LED, segs=8)
    add_cylinder(bm, (-0.088, 0.185, 0.172), (0.088, 0.185, 0.172), 0.014, 0.014, MAT_JOINT_METAL, segs=6)

    for side in (-1.0, 1.0):
        tx = side * 0.084
        tz = 0.176
        # Vertical pressurized cryo canister shell
        add_cylinder(bm, (tx, 0.165, tz), (tx, 0.435, tz), 0.046, 0.046, MAT_ARMOR_PRIMARY, segs=10)
        # Beveled conical tank end caps (crisp industrial pressure domes)
        add_cylinder(bm, (tx, 0.435, tz), (tx, 0.464, tz), 0.046, 0.026, MAT_ARMOR_SECONDARY, segs=10)
        add_cylinder(bm, (tx, 0.138, tz), (tx, 0.165, tz), 0.028, 0.046, MAT_ARMOR_SECONDARY, segs=10)
        # Armored clamping collar bands around tank
        for by in (0.215, 0.300, 0.385):
            add_cylinder(bm, (tx, by - 0.010, tz), (tx, by + 0.010, tz), 0.051, 0.051, MAT_CHASSIS_DARK, segs=10)
        # Glowing vertical cryo level sight-glass strip on back face
        add_box(bm, (tx, 0.300, tz + 0.046), (0.018, 0.165, 0.008), MAT_VISOR_LED, bevel=0.0)
        add_box(bm, (tx + side * 0.044, 0.300, tz), (0.008, 0.145, 0.018), MAT_TEAM_STRIPE, bevel=0.0)
        # Upper shoulder cryo feed pipe arching toward collar
        add_cylinder(bm, (tx, 0.460, tz), (side * 0.072, 0.485, 0.092), 0.012, 0.011, MAT_JOINT_METAL, segs=6)

    return finalize_object("Kit_Blue", bm, materials, (0.0, WAIST_Y, 0.0))


def build_kit_green(materials: list[bpy.types.Material]) -> bpy.types.Object:
    """PULSE (Green) — Recon Sensor Array + Folded Hexagonal Dish + Twin Comms Antennae."""
    bm = bmesh.new()

    # Main rectangular beveled recon transceiver pack
    add_box(bm, (0.0, 0.300, 0.162), (0.210, 0.255, 0.088), MAT_ARMOR_PRIMARY, bevel=0.014)
    add_box(bm, (0.0, 0.295, 0.205), (0.165, 0.195, 0.022), MAT_CHASSIS_DARK, bevel=0.006)
    # Central glowing sonar pulse ring + emitter core
    add_torus(bm, (0.0, 0.295, 0.218), 0.052, 0.009, MAT_TEAM_STRIPE, major_segs=10, minor_segs=4, rot=(math.pi * 0.5, 0.0, 0.0), smooth=False)
    add_octahedron(bm, (0.0, 0.295, 0.220), (0.028, 0.028, 0.014), MAT_VISOR_LED)

    # Right-upper asymmetric folded hexagonal recon radar dish
    add_cylinder(bm, (0.068, 0.415, 0.175), (0.105, 0.485, 0.215), 0.014, 0.012, MAT_JOINT_METAL, segs=8)
    add_cylinder(
        bm,
        (0.112, 0.495, 0.208),
        (0.126, 0.510, 0.232),
        0.078,
        0.088,
        MAT_ARMOR_SECONDARY,
        segs=6,
        smooth=False,
    )
    add_cylinder(
        bm,
        (0.118, 0.502, 0.218),
        (0.132, 0.518, 0.242),
        0.048,
        0.016,
        MAT_ARMOR_PRIMARY,
        segs=6,
        smooth=False,
    )
    # Dish feed horn emitter tip
    add_cylinder(bm, (0.126, 0.510, 0.232), (0.145, 0.532, 0.264), 0.008, 0.006, MAT_JOINT_METAL, segs=8)
    add_sphere(bm, (0.148, 0.536, 0.268), 0.012, MAT_VISOR_LED, segs=8, rings=6)

    # Left-upper twin telescoping comms / recon whip antennae
    add_box(bm, (-0.082, 0.432, 0.168), (0.048, 0.056, 0.052), MAT_ARMOR_SECONDARY, bevel=0.006)
    add_cylinder(bm, (-0.092, 0.455, 0.172), (-0.118, 0.675, 0.202), 0.009, 0.004, MAT_JOINT_METAL, segs=8)
    add_sphere(bm, (-0.119, 0.682, 0.203), 0.013, MAT_VISOR_LED, segs=8, rings=6)
    add_cylinder(bm, (-0.068, 0.455, 0.162), (-0.082, 0.590, 0.180), 0.007, 0.0035, MAT_JOINT_METAL, segs=8)
    add_box(bm, (-0.082, 0.432, 0.195), (0.032, 0.014, 0.008), MAT_VISOR_LED, bevel=0.002)

    return finalize_object("Kit_Green", bm, materials, (0.0, WAIST_Y, 0.0))


def build_kit_violet(materials: list[bpy.types.Material]) -> bpy.types.Object:
    """UMBRA (Violet) — Angular Shadow Shroud Fins + Void Reactor Core."""
    bm = bmesh.new()

    # Hexagonal armored void reactor core housing along spine
    add_cylinder(bm, (0.0, 0.310, 0.125), (0.0, 0.310, 0.196), 0.088, 0.074, MAT_CHASSIS_DARK, segs=6, smooth=False)
    add_torus(bm, (0.0, 0.310, 0.194), 0.066, 0.012, MAT_ARMOR_SECONDARY, major_segs=6, minor_segs=6, rot=(math.pi * 0.5, 0.0, 0.0), smooth=False)
    # Recessed glowing faceted octahedral void reactor crystal
    add_octahedron(bm, (0.0, 0.310, 0.200), (0.036, 0.048, 0.026), MAT_VISOR_LED)
    # Upper & lower spine pylon stabilizers
    add_box(bm, (0.0, 0.415, 0.158), (0.044, 0.095, 0.042), MAT_ARMOR_SECONDARY, bevel=0.006, rot=(-0.22, 0.0, 0.0))
    add_box(bm, (0.0, 0.195, 0.152), (0.040, 0.088, 0.036), MAT_ARMOR_SECONDARY, bevel=0.006, rot=(0.18, 0.0, 0.0))

    # 4 sharp angular stealth shroud wing-fins (upper wide pair + lower sleek pair)
    upper_fin = [(0.0, -0.02), (0.075, 0.185), (0.145, 0.255), (0.115, 0.105), (0.035, -0.065)]
    lower_fin = [(0.0, 0.01), (0.095, -0.025), (0.145, -0.145), (0.068, -0.110), (0.018, -0.045)]
    for side in (-1.0, 1.0):
        # Upper swept shroud blade
        add_prism(
            bm,
            upper_fin,
            0.016,
            (side * 0.068, 0.365, 0.158),
            MAT_ARMOR_PRIMARY,
            rot=(0.0, side * 0.56, -side * 0.36),
            bevel=0.004,
            plane="YZ",
        )
        # Inner team-stripe shroud accent vane
        add_box(
            bm,
            (side * 0.118, 0.465, 0.205),
            (0.010, 0.135, 0.018),
            MAT_TEAM_STRIPE,
            bevel=0.002,
            rot=(-0.38, side * 0.32, -side * 0.48),
        )
        # Lower angled shadow stabilizer fin
        add_prism(
            bm,
            lower_fin,
            0.014,
            (side * 0.065, 0.245, 0.158),
            MAT_ARMOR_PRIMARY,
            rot=(0.0, side * 0.46, side * 0.22),
            bevel=0.003,
            plane="YZ",
        )
        # Glowing energy conduit pin linking reactor to wing root
        add_cylinder(bm, (side * 0.048, 0.335, 0.176), (side * 0.096, 0.395, 0.186), 0.009, 0.007, MAT_VISOR_LED, segs=8)

    return finalize_object("Kit_Violet", bm, materials, (0.0, WAIST_Y, 0.0))


def build_kit_gold(materials: list[bpy.types.Material]) -> bpy.types.Object:
    """VOLT (Gold) — Dual Surge Tesla Coils + High-Voltage Capacitor Battery."""
    bm = bmesh.new()

    # Central high-voltage capacitor battery housing
    add_box(bm, (0.0, 0.275, 0.160), (0.165, 0.185, 0.076), MAT_CHASSIS_DARK, bevel=0.010)
    add_box(bm, (0.0, 0.275, 0.194), (0.132, 0.145, 0.020), MAT_ARMOR_SECONDARY, bevel=0.0)
    # 3 glowing capacitor charge level bars
    for by in (0.232, 0.275, 0.318):
        add_box(bm, (0.0, by, 0.205), (0.088, 0.016, 0.008), MAT_VISOR_LED, bevel=0.0)

    # Twin outward-splayed Surge Tesla Coil Pylons
    for side in (-1.0, 1.0):
        base = Vector((side * 0.074, 0.330, 0.172))
        top = Vector((side * 0.168, 0.610, 0.208))
        axis = (top - base).normalized()
        # Machined base mount socket + core conductor mast
        add_sphere(bm, tuple(base), 0.028, MAT_ARMOR_SECONDARY, segs=8, rings=5)
        add_cylinder(bm, tuple(base), tuple(top), 0.016, 0.011, MAT_JOINT_METAL, segs=8)
        # 3 stacked armored Tesla insulator coil flanges along the pylon
        rot_q = Vector((0.0, 1.0, 0.0)).rotation_difference(axis)
        rot_e = rot_q.to_euler("XYZ")
        for idx, t in enumerate((0.30, 0.54, 0.78)):
            pos = base.lerp(top, t)
            maj_r = 0.042 - idx * 0.004
            p0 = pos - axis * 0.009
            p1 = pos + axis * 0.009
            add_cylinder(
                bm,
                tuple(p0),
                tuple(p1),
                maj_r,
                maj_r * 0.90,
                MAT_ARMOR_PRIMARY if idx != 1 else MAT_TEAM_STRIPE,
                segs=10,
                smooth=False,
            )
        # Glowing high-voltage arc discharge emitter crown at pylon tip
        add_octahedron(bm, tuple(top + axis * 0.018), (0.024, 0.028, 0.024), MAT_VISOR_LED, rot=(rot_e.x, rot_e.y, rot_e.z))

    return finalize_object("Kit_Gold", bm, materials, (0.0, WAIST_Y, 0.0))


# ---------------------------------------------------------------------------
# Verification helper: parse the exported GLB binary JSON directly!
# ---------------------------------------------------------------------------
def inspect_exported_glb(glb_path: str) -> None:
    size_bytes = os.path.getsize(glb_path)
    with open(glb_path, "rb") as f:
        header = f.read(12)
        magic, version, total_len = struct.unpack("<4sII", header)
        chunk_len, chunk_type = struct.unpack("<II", f.read(8))
        json_bytes = f.read(chunk_len)

    assert magic == b"glTF", f"Invalid GLB magic: {magic!r}"
    doc = json.loads(json_bytes.decode("utf-8"))

    accessors = doc.get("accessors", [])
    meshes = doc.get("meshes", [])
    nodes = doc.get("nodes", [])
    mats = [m.get("name") for m in doc.get("materials", [])]

    print("=" * 78)
    print(f"GLB VERIFICATION: {glb_path}")
    print(f"  Magic: {magic.decode('ascii')} v{version} | Size: {size_bytes:,} bytes ({size_bytes / 1024:.1f} KB)")
    print(f"  Materials ({len(mats)}): {mats}")
    print(f"  Nodes ({len(nodes)}) — Three.js Y-up local mesh bounds & node translations:")

    total_tris = 0
    for node in nodes:
        name = node.get("name", "<unnamed>")
        trans = node.get("translation", [0.0, 0.0, 0.0])
        m_idx = node.get("mesh")
        if m_idx is None:
            continue
        mesh_def = meshes[m_idx]
        min_v = [1e9, 1e9, 1e9]
        max_v = [-1e9, -1e9, -1e9]
        node_tris = 0
        for prim in mesh_def.get("primitives", []):
            pos_acc = accessors[prim["attributes"]["POSITION"]]
            for i in range(3):
                min_v[i] = min(min_v[i], pos_acc["min"][i])
                max_v[i] = max(max_v[i], pos_acc["max"][i])
            if "indices" in prim:
                node_tris += accessors[prim["indices"]]["count"] // 3
            else:
                node_tris += pos_acc["count"] // 3
        total_tris += node_tris
        dims = [max_v[i] - min_v[i] for i in range(3)]
        print(
            f"    {name:<18s} tris={node_tris:4d}  "
            f"X=[{min_v[0]:+.3f},{max_v[0]:+.3f}] "
            f"Y=[{min_v[1]:+.3f},{max_v[1]:+.3f}] (h={dims[1]:.3f}m) "
            f"Z=[{min_v[2]:+.3f},{max_v[2]:+.3f}]  "
            f"pos=({trans[0]:+.2f},{trans[1]:+.2f},{trans[2]:+.2f})"
        )
    print(f"  TOTAL TRIANGLES (all 16 nodes): {total_tris:,}")
    print("=" * 78)


def main() -> None:
    clear_scene()
    materials = build_materials()

    # Core articulated KAY/O body segments (11 parts)
    build_kayo_pelvis(materials)
    build_kayo_torso(materials)
    build_kayo_head(materials)
    build_kayo_upper_arm(-1.0, "Kayo_UpperArm_L", materials)
    build_kayo_upper_arm(+1.0, "Kayo_UpperArm_R", materials)
    build_kayo_forearm(-1.0, "Kayo_Forearm_L", materials)
    build_kayo_forearm(+1.0, "Kayo_Forearm_R", materials)
    build_kayo_thigh(-1.0, "Kayo_Thigh_L", materials)
    build_kayo_thigh(+1.0, "Kayo_Thigh_R", materials)
    build_kayo_shin(-1.0, "Kayo_Shin_L", materials)
    build_kayo_shin(+1.0, "Kayo_Shin_R", materials)

    # 5 distinct Agent Dorsal Kits
    build_kit_red(materials)
    build_kit_blue(materials)
    build_kit_green(materials)
    build_kit_violet(materials)
    build_kit_gold(materials)

    # Resolve output path relative to chroma-strike repo root (2 levels above scripts/blender/)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    out_dir = os.path.join(project_root, "public", "models")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "agent_kayo.glb")

    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_normals=True,
        export_materials="EXPORT",
        export_animations=False,
    )

    inspect_exported_glb(out_path)


if __name__ == "__main__":
    main()
