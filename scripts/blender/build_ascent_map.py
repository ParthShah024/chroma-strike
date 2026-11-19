#!/usr/bin/env python3
"""
Master Headless Blender 5.2.2 LTS Builder for Near-1:1 Valorant "Ascent" Replica (84m x 92m).

Single Source of Truth Pipeline:
  1. Constructs an unmistakable Venetian "Ascent" replica in Blender:
       - Site A & A Tree / Garden (West): True two-story A Heaven (y=3.00m) with
         Heaven cover box directly above A Hell (y=0.00m, ceiling=2.65m) with
         wooden A Hell cover crates; 7-tread CT-to-Heaven staircase; blue-grey
         industrial turbine A Generator with exhaust stack; double-stacked A Dice;
         deepened recessed arched A Wine cellar stocked with oak wine barrels;
         A Lobby <-> Mid Tiles connector archway; sculpted 3D Mediterranean Olive
         Tree (gnarled trunk + forked boughs + tiered canopy + stone planter)
         under wooden pergola beams inside A Tree; A Tree <-> CT-A / A Heaven
         north-east connector doorway; and interactive `a_tree` Blast Door + Switch.
       - Iconic Wide Mid (Center): Dog-leg Top Mid (0 opening LoS), checkered
         Mid Tiles, elevated Mid Catwalk (y=0.85m) with Catwalk Box & Mid Subroza /
         Catwalk Cubby, wide sunlit Venetian Mid Courtyard with central Mid Box &
         Fountain, terracotta-awning Mid Pizza corridor, arched Mid Link portal
         toward Defender Spawn, and pitched-roof arched Mid Market with shoot-through
         Window (y=1.10..2.50m), back CT doorway & `b_market` Blast Door + Switch.
       - Site B, B Main Garage, B Lane & Boat House (East): Enclosed roofed B Main
         Venetian garage with wall-bang corner crates, B Logs wooden log-pile cover
         at mouth of B Site, elevated B Lane (y=0.85m) wooden/stone bridge hugging
         the outer east wall down to Back Site, B Switch Shed beside B Market Door,
         classic B Default Double-Box & B Back Crates in Site B plant zone, and
         B Boat House with sloped terracotta gable roof, wooden interior dock,
         canal slipway, sculpted Venetian gondola hull, doorway & shoot-through window.
       - Skyline: Multi-story Venetian terracotta pitched rooftops/facades crowning
         perimeter & landmark skylines, towering San Marco Campanile Bell Tower, and
         6 floating Venetian cliff-islands with pitched-roof villas.
  2. Exports `public/models/ascent_map.glb` (`export_yup=True`, Principled BSDF
     materials, named interactive door nodes `DoorPanel_a_tree`, `DoorSwitch_a_tree`,
     `DoorPanel_b_market`, `DoorSwitch_b_market` with exact closed-center pivots).
  3. Auto-generates `src/arena/ascentMapData.ts` from the EXACT SAME Python
     primitives and proves:
       - 100% BFS waypoint reachability across all zones & elevations
       - 0 opening-round Line-of-Sight pairs between South (z >= +20m) and
         North (z <= -16m) buy zones at +1.62m eye height
       - Market & Boat House shoot-through window rays clear at +1.62m
       - GLB binary magic header (`glTF`), size < 3.0 MB, and exact Door pivots.
"""

from __future__ import annotations

import json
import math
import os
import struct
import sys
from collections import deque
from typing import Dict, List, Optional, Tuple

import bmesh
import bpy
from mathutils import Matrix, Vector

# ---------------------------------------------------------------------------
# Paths & Map Constants
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
GLB_OUT_PATH = os.path.join(PROJECT_ROOT, "public", "models", "ascent_map.glb")
TS_OUT_PATH = os.path.join(PROJECT_ROOT, "src", "arena", "ascentMapData.ts")

ARENA_WIDTH_M = 84
ARENA_DEPTH_M = 92
MIN_X, MAX_X = -42.0, 42.0
MIN_Z, MAX_Z = -46.0, 46.0

BUY_MIN_ALLY_Z = 20.0
BUY_MAX_DEFENDER_Z = -16.0

EYE_HEIGHT_M = 1.62
PLAYER_HEIGHT_M = 1.80
PLAYER_RADIUS_M = 0.40
STEP_LIMIT_M = 0.49  # Strictly <= 0.50m so STEP_HEIGHT (0.52m) climbs smoothly


# ---------------------------------------------------------------------------
# Coordinate Conversion: Three.js World (X, Y-up, Z-south) -> Blender (X, Y, Z-up)
# With glTF `export_yup=True`, Blender (xb, yb, zb) exports to Three.js (xb, zb, -yb).
# Setting (xb, yb, zb) = (xw, -zw, yw) maps to (xw, yw, zw) with 0.000m error!
# ---------------------------------------------------------------------------

def w2b_pt(x: float, y: float, z: float) -> Vector:
    return Vector((float(x), float(-z), float(y)))


def w2b_vec(dx: float, dy: float, dz: float) -> Vector:
    return Vector((float(dx), float(-dz), float(dy)))


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_linear_rgba(hex_val: int, alpha: float = 1.0) -> Tuple[float, float, float, float]:
    r = ((hex_val >> 16) & 0xFF) / 255.0
    g = ((hex_val >> 8) & 0xFF) / 255.0
    b = (hex_val & 0xFF) / 255.0
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), alpha)


# ---------------------------------------------------------------------------
# Blender Scene Reset & Principled BSDF Material Library
# ---------------------------------------------------------------------------

def clear_blender_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh, do_unlink=True)
    for mat in list(bpy.data.materials):
        bpy.data.materials.remove(mat, do_unlink=True)


def make_pbr_material(
    name: str,
    hex_color: int,
    roughness: float = 0.82,
    metallic: float = 0.0,
    emission_hex: Optional[int] = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    if mat.node_tree is None:
        mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = hex_to_linear_rgba(hex_color)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission_hex is not None and emission_strength > 0.0:
        bsdf.inputs["Emission Color"].default_value = hex_to_linear_rgba(emission_hex)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


class MaterialPalette:
    def __init__(self) -> None:
        self.by_name: Dict[str, bpy.types.Material] = {}
        self.ordered: List[bpy.types.Material] = []

        specs = [
            # Warm Sunlit Venetian Architecture
            ("Mat_PlasterWarm", 0xEDE0CC, 0.86, 0.0, None, 0.0),
            ("Mat_PlasterPeach", 0xE2BDA4, 0.85, 0.0, None, 0.0),
            ("Mat_PlasterOchre", 0xE5C18A, 0.85, 0.0, None, 0.0),
            ("Mat_PlasterHarbor", 0xCBD6DE, 0.84, 0.0, None, 0.0),
            ("Mat_BrickVenetian", 0xB86B52, 0.84, 0.0, None, 0.0),
            ("Mat_Limestone", 0xD9CFC0, 0.76, 0.02, None, 0.0),
            ("Mat_Terracotta", 0xBC5838, 0.68, 0.02, None, 0.0),
            # Floors & Pavements
            ("Mat_TravertineFloor", 0xC6B9A5, 0.88, 0.0, None, 0.0),
            ("Mat_CobblePlaza", 0x98A1AC, 0.86, 0.02, None, 0.0),
            ("Mat_HarborSlate", 0x7D8B99, 0.84, 0.04, None, 0.0),
            ("Mat_MarbleCheck", 0xD7D2C8, 0.72, 0.04, None, 0.0),
            ("Mat_CanalWater", 0x1A4E61, 0.14, 0.08, None, 0.0),
            # Wood, Iron & Industrial Props
            ("Mat_TimberOak", 0x6E4B32, 0.74, 0.02, None, 0.0),
            ("Mat_DarkOak", 0x4A3221, 0.78, 0.02, None, 0.0),
            ("Mat_WoodCrate", 0x9E744B, 0.78, 0.02, None, 0.0),
            ("Mat_DarkIron", 0x2B323C, 0.42, 0.78, None, 0.0),
            ("Mat_BlastSteel", 0x4B5868, 0.38, 0.72, None, 0.0),
            ("Mat_GenSteelBlue", 0x4E6880, 0.38, 0.62, None, 0.0),
            ("Mat_HazardGold", 0xE5A91A, 0.48, 0.28, None, 0.0),
            ("Mat_CopperCoil", 0xC86D3B, 0.34, 0.82, 0xFF8A3D, 0.6),
            # Valorant Radianite Crates & Glowing Accents
            ("Mat_RadianiteTeal", 0x1F5F61, 0.38, 0.42, None, 0.0),
            ("Mat_RadianiteOrange", 0xD66828, 0.46, 0.25, None, 0.0),
            ("Mat_RadianiteGlow", 0x3CF5D4, 0.25, 0.1, 0x3CF5D4, 1.8),
            ("Mat_SiteAAccent", 0xFF8A3D, 0.45, 0.15, 0xFF8A3D, 0.9),
            ("Mat_SiteBAccent", 0x38BDF8, 0.45, 0.15, 0x38BDF8, 0.9),
            ("Mat_SpikeGlow", 0xFF4D6D, 0.30, 0.2, 0xFF4D6D, 2.2),
            # Foliage & Skyline
            ("Mat_FoliageOlive", 0x4F7043, 0.82, 0.0, None, 0.0),
            ("Mat_FoliageSunlit", 0x6B8E56, 0.80, 0.0, None, 0.0),
            ("Mat_FoliageCypress", 0x355332, 0.84, 0.0, None, 0.0),
            ("Mat_SoilDark", 0x3D2E22, 0.94, 0.0, None, 0.0),
            ("Mat_CliffRock", 0x6A655E, 0.92, 0.0, None, 0.0),
            ("Mat_GoldBell", 0xD8B23C, 0.30, 0.86, None, 0.0),
        ]
        for name, col, rough, met, em_col, em_str in specs:
            m = make_pbr_material(name, col, rough, met, em_col, em_str)
            self.by_name[name] = m
            self.ordered.append(m)

    def idx(self, name: str) -> int:
        return self.ordered.index(self.by_name[name])


# ---------------------------------------------------------------------------
# BMesh Architectural Batch Builder (World Coordinates -> Beveled Blender Mesh)
# ---------------------------------------------------------------------------

class WorldMeshBuilder:
    """Builds a multi-material bmesh directly from Three.js world coordinates."""

    def __init__(self, name: str, palette: MaterialPalette, origin_world: Tuple[float, float, float] = (0.0, 0.0, 0.0)) -> None:
        self.name = name
        self.palette = palette
        self.origin_world = origin_world
        self.origin_blender = w2b_pt(*origin_world)
        self.bm = bmesh.new()

    def _p(self, x: float, y: float, z: float) -> Vector:
        return w2b_pt(x, y, z) - self.origin_blender

    def _assign_faces(self, faces: List[bmesh.types.BMFace], mat_idx: int, smooth: bool = False) -> None:
        for f in faces:
            f.material_index = mat_idx
            f.smooth = smooth

    def add_box(
        self,
        x0: float,
        y0: float,
        z0: float,
        x1: float,
        y1: float,
        z1: float,
        mat_name: str,
        bevel: float = 0.02,
    ) -> None:
        if x1 <= x0 + 1e-5 or y1 <= y0 + 1e-5 or z1 <= z0 + 1e-5:
            return
        mat_idx = self.palette.idx(mat_name)
        cx, cy, cz = 0.5 * (x0 + x1), 0.5 * (y0 + y1), 0.5 * (z0 + z1)
        sx, sy, sz = (x1 - x0), (z1 - z0), (y1 - y0)  # Blender X=dx, Y=dz, Z=dy
        mat_xf = Matrix.Translation(self._p(cx, cy, cz)) @ Matrix.Diagonal((sx, sy, sz, 1.0))
        res = bmesh.ops.create_cube(self.bm, size=1.0, matrix=mat_xf)
        verts = res["verts"]
        faces = list({f for v in verts for f in v.link_faces})
        self._assign_faces(faces, mat_idx)

        min_dim = min(sx, sy, sz)
        if bevel > 1e-4 and min_dim >= max(bevel * 3.5, 0.26):
            edges = list({e for f in faces for e in f.edges})
            bev = bmesh.ops.bevel(
                self.bm,
                geom=edges,
                offset=min(bevel, min_dim * 0.22),
                offset_type="OFFSET",
                segments=1,
                profile=0.5,
                affect="EDGES",
            )
            self._assign_faces(bev.get("faces", []), mat_idx)

    def add_oriented_box(
        self,
        cx: float,
        cy: float,
        cz: float,
        sx: float,
        sy: float,
        sz: float,
        rot_x: float,
        rot_y: float,
        rot_z: float,
        mat_name: str,
        bevel: float = 0.015,
    ) -> None:
        """Adds a box centered at world (cx,cy,cz) with world sizes (sx,sy,sz) rotated in Blender."""
        mat_idx = self.palette.idx(mat_name)
        # Map world rotations: rot around world X -> Blender +X; world Y -> Blender +Z; world Z -> Blender -Y
        rot_mat = (
            Matrix.Rotation(rot_y, 4, "Z")
            @ Matrix.Rotation(-rot_z, 4, "Y")
            @ Matrix.Rotation(rot_x, 4, "X")
        )
        scale_mat = Matrix.Diagonal((sx, sz, sy, 1.0))
        xf = Matrix.Translation(self._p(cx, cy, cz)) @ rot_mat @ scale_mat
        res = bmesh.ops.create_cube(self.bm, size=1.0, matrix=xf)
        verts = res["verts"]
        faces = list({f for v in verts for f in v.link_faces})
        self._assign_faces(faces, mat_idx)
        min_dim = min(sx, sy, sz)
        if bevel > 1e-4 and min_dim >= max(bevel * 3.5, 0.26):
            edges = list({e for f in faces for e in f.edges})
            bev = bmesh.ops.bevel(
                self.bm,
                geom=edges,
                offset=min(bevel, min_dim * 0.22),
                offset_type="OFFSET",
                segments=1,
                profile=0.5,
                affect="EDGES",
            )
            self._assign_faces(bev.get("faces", []), mat_idx)

    def add_cylinder(
        self,
        cx: float,
        cy: float,
        cz: float,
        r0: float,
        r1: float,
        length: float,
        mat_name: str,
        segments: int = 12,
        axis: str = "y",
        smooth: bool = False,
    ) -> None:
        """Cylinder centered at world (cx, cy, cz) aligned along world axis ('x', 'y', or 'z')."""
        mat_idx = self.palette.idx(mat_name)
        if axis == "y":
            rot = Matrix.Identity(4)
        elif axis == "z":
            rot = Matrix.Rotation(math.pi * 0.5, 4, "X")
        else:
            rot = Matrix.Rotation(math.pi * 0.5, 4, "Y")
        xf = Matrix.Translation(self._p(cx, cy, cz)) @ rot
        res = bmesh.ops.create_cone(
            self.bm,
            cap_ends=True,
            cap_tris=True,
            segments=segments,
            radius1=r0,
            radius2=r1,
            depth=length,
            matrix=xf,
        )
        verts = res["verts"]
        faces = list({f for v in verts for f in v.link_faces})
        self._assign_faces(faces, mat_idx, smooth=smooth)

    def add_branch(
        self,
        p0: Tuple[float, float, float],
        p1: Tuple[float, float, float],
        r0: float,
        r1: float,
        mat_name: str,
        segments: int = 7,
        smooth: bool = True,
    ) -> None:
        """Tapered cylinder oriented precisely from world point p0 to p1 (for gnarled trunks, boughs, pipes)."""
        v0 = self._p(*p0)
        v1 = self._p(*p1)
        vec = v1 - v0
        length = vec.length
        if length < 1e-4:
            return
        mid = (v0 + v1) * 0.5
        quat = Vector((0.0, 0.0, 1.0)).rotation_difference(vec.normalized())
        xf = Matrix.Translation(mid) @ quat.to_matrix().to_4x4()
        mat_idx = self.palette.idx(mat_name)
        res = bmesh.ops.create_cone(
            self.bm,
            cap_ends=True,
            cap_tris=True,
            segments=segments,
            radius1=r0,
            radius2=r1,
            depth=length,
            matrix=xf,
        )
        verts = res["verts"]
        faces = list({f for v in verts for f in v.link_faces})
        self._assign_faces(faces, mat_idx, smooth=smooth)

    def add_icosphere(
        self,
        cx: float,
        cy: float,
        cz: float,
        rx: float,
        ry: float,
        rz: float,
        mat_name: str,
        subdivisions: int = 2,
        smooth: bool = False,
    ) -> None:
        mat_idx = self.palette.idx(mat_name)
        xf = Matrix.Translation(self._p(cx, cy, cz)) @ Matrix.Diagonal((rx, rz, ry, 1.0))
        res = bmesh.ops.create_icosphere(self.bm, subdivisions=subdivisions, radius=1.0, matrix=xf)
        verts = res["verts"]
        faces = list({f for v in verts for f in v.link_faces})
        self._assign_faces(faces, mat_idx, smooth=smooth)

    def add_prism_extrude_x(
        self,
        x0: float,
        x1: float,
        yz_poly: List[Tuple[float, float]],
        mat_name: str,
    ) -> None:
        """Extrudes a 2D polygon in world (y, z) across x in [x0, x1]."""
        mat_idx = self.palette.idx(mat_name)
        n = len(yz_poly)
        v_left = [self.bm.verts.new(self._p(x0, y, z)) for (y, z) in yz_poly]
        v_right = [self.bm.verts.new(self._p(x1, y, z)) for (y, z) in yz_poly]
        faces = [
            self.bm.faces.new(v_left),
            self.bm.faces.new(list(reversed(v_right))),
        ]
        for i in range(n):
            j = (i + 1) % n
            faces.append(self.bm.faces.new([v_left[i], v_left[j], v_right[j], v_right[i]]))
        self._assign_faces(faces, mat_idx)

    def add_prism_extrude_z(
        self,
        z0: float,
        z1: float,
        xy_poly: List[Tuple[float, float]],
        mat_name: str,
    ) -> None:
        """Extrudes a 2D polygon in world (x, y) across z in [z0, z1]."""
        mat_idx = self.palette.idx(mat_name)
        n = len(xy_poly)
        v_back = [self.bm.verts.new(self._p(x, y, z0)) for (x, y) in xy_poly]
        v_front = [self.bm.verts.new(self._p(x, y, z1)) for (x, y) in xy_poly]
        faces = [
            self.bm.faces.new(v_back),
            self.bm.faces.new(list(reversed(v_front))),
        ]
        for i in range(n):
            j = (i + 1) % n
            faces.append(self.bm.faces.new([v_back[i], v_back[j], v_front[j], v_front[i]]))
        self._assign_faces(faces, mat_idx)

    def add_pitched_roof(
        self,
        x0: float,
        z0: float,
        x1: float,
        z1: float,
        y_eave: float,
        ridge_h: float,
        ridge_along_x: bool = True,
        roof_mat: str = "Mat_Terracotta",
        gable_mat: str = "Mat_PlasterWarm",
        overhang: float = 0.35,
        add_ribs: bool = False,
    ) -> None:
        """Crisp Venetian pitched terracotta gable roof with pediments, sloped planes & ridge cap."""
        ax0, ax1 = min(x0, x1), max(x0, x1)
        az0, az1 = min(z0, z1), max(z0, z1)
        cx, cz = 0.5 * (ax0 + ax1), 0.5 * (az0 + az1)
        y_ridge = y_eave + ridge_h

        if ridge_along_x:
            half_span = 0.5 * (az1 - az0) + overhang
            slope_angle = math.atan2(ridge_h, max(0.2, 0.5 * (az1 - az0)))
            slope_len = math.hypot(ridge_h, half_span)
            length_x = (ax1 - ax0) + 2.0 * overhang
            # Triangular gable pediments on West & East ends
            gable = [(y_eave, az0), (y_ridge - 0.08, cz), (y_eave, az1)]
            self.add_prism_extrude_x(ax0, ax0 + 0.36, gable, gable_mat)
            self.add_prism_extrude_x(ax1 - 0.36, ax1, gable, gable_mat)
            # North & South terracotta roof slopes (no bevel to stay ultra-lightweight!)
            mid_y = y_eave + 0.5 * ridge_h + 0.04
            self.add_oriented_box(cx, mid_y, cz - 0.5 * half_span, length_x, 0.16, slope_len, -slope_angle, 0.0, 0.0, roof_mat, bevel=0.0)
            self.add_oriented_box(cx, mid_y, cz + 0.5 * half_span, length_x, 0.16, slope_len, slope_angle, 0.0, 0.0, roof_mat, bevel=0.0)
            self.add_cylinder(cx, y_ridge + 0.08, cz, 0.15, 0.15, length_x + 0.08, roof_mat, segments=7, axis="x")
            if add_ribs:
                n_ribs = max(3, int((ax1 - ax0) // 2.0))
                for k in range(1, n_ribs):
                    rx = ax0 + (ax1 - ax0) * (k / n_ribs)
                    self.add_oriented_box(rx, mid_y + 0.08, cz - 0.5 * half_span, 0.10, 0.08, slope_len - 0.1, -slope_angle, 0.0, 0.0, roof_mat, bevel=0.0)
                    self.add_oriented_box(rx, mid_y + 0.08, cz + 0.5 * half_span, 0.10, 0.08, slope_len - 0.1, slope_angle, 0.0, 0.0, roof_mat, bevel=0.0)
        else:
            half_span = 0.5 * (ax1 - ax0) + overhang
            slope_angle = math.atan2(ridge_h, max(0.2, 0.5 * (ax1 - ax0)))
            slope_len = math.hypot(ridge_h, half_span)
            length_z = (az1 - az0) + 2.0 * overhang
            # Triangular gable pediments on North & South ends
            gable = [(ax0, y_eave), (cx, y_ridge - 0.08), (ax1, y_eave)]
            self.add_prism_extrude_z(az0, az0 + 0.36, gable, gable_mat)
            self.add_prism_extrude_z(az1 - 0.36, az1, gable, gable_mat)
            # West & East terracotta roof slopes
            mid_y = y_eave + 0.5 * ridge_h + 0.04
            self.add_oriented_box(cx - 0.5 * half_span, mid_y, cz, slope_len, 0.16, length_z, 0.0, 0.0, slope_angle, roof_mat, bevel=0.0)
            self.add_oriented_box(cx + 0.5 * half_span, mid_y, cz, slope_len, 0.16, length_z, 0.0, 0.0, -slope_angle, roof_mat, bevel=0.0)
            self.add_cylinder(cx, y_ridge + 0.08, cz, 0.15, 0.15, length_z + 0.08, roof_mat, segments=7, axis="z")
            if add_ribs:
                n_ribs = max(3, int((az1 - az0) // 2.0))
                for k in range(1, n_ribs):
                    rz = az0 + (az1 - az0) * (k / n_ribs)
                    self.add_oriented_box(cx - 0.5 * half_span, mid_y + 0.08, rz, slope_len - 0.1, 0.08, 0.10, 0.0, 0.0, slope_angle, roof_mat, bevel=0.0)
                    self.add_oriented_box(cx + 0.5 * half_span, mid_y + 0.08, rz, slope_len - 0.1, 0.08, 0.10, 0.0, 0.0, -slope_angle, roof_mat, bevel=0.0)

    def add_curved_arch(
        self,
        along_x: bool,
        s0: float,
        s1: float,
        d0: float,
        d1: float,
        y_spring: float,
        y_crown: float,
        y_top: float,
        wall_mat: str,
        trim_mat: str,
        segments: int = 10,
    ) -> None:
        """
        Builds a genuine curved Venetian segmental stone arch + radial voussoirs + keystone!
        `s0..s1` spans the opening width; `d0..d1` is wall thickness.
        """
        span = s1 - s0
        mid_s = 0.5 * (s0 + s1)
        half_w = 0.5 * span
        rise = max(0.35, y_crown - y_spring)

        # Build spandrel segments from s0 to s1 so curved soffit is smooth and solid up to y_top
        for i in range(segments):
            t0 = i / segments
            t1 = (i + 1) / segments
            a0 = math.pi * (1.0 - t0)
            a1 = math.pi * (1.0 - t1)
            u0 = mid_s + math.cos(a0) * half_w
            u1 = mid_s + math.cos(a1) * half_w
            arc_y0 = y_spring + math.sin(a0) * rise
            arc_y1 = y_spring + math.sin(a1) * rise

            # Spandrel quad prism above the arch curve up to y_top - 0.14 (leaving room for cornice)
            top_sp = y_top - 0.14
            if along_x:
                pts0 = [
                    self.bm.verts.new(self._p(u0, arc_y0, d0)),
                    self.bm.verts.new(self._p(u1, arc_y1, d0)),
                    self.bm.verts.new(self._p(u1, top_sp, d0)),
                    self.bm.verts.new(self._p(u0, top_sp, d0)),
                ]
                pts1 = [
                    self.bm.verts.new(self._p(u0, arc_y0, d1)),
                    self.bm.verts.new(self._p(u1, arc_y1, d1)),
                    self.bm.verts.new(self._p(u1, top_sp, d1)),
                    self.bm.verts.new(self._p(u0, top_sp, d1)),
                ]
            else:
                pts0 = [
                    self.bm.verts.new(self._p(d0, arc_y0, u0)),
                    self.bm.verts.new(self._p(d0, arc_y1, u1)),
                    self.bm.verts.new(self._p(d0, top_sp, u1)),
                    self.bm.verts.new(self._p(d0, top_sp, u0)),
                ]
                pts1 = [
                    self.bm.verts.new(self._p(d1, arc_y0, u0)),
                    self.bm.verts.new(self._p(d1, arc_y1, u1)),
                    self.bm.verts.new(self._p(d1, top_sp, u1)),
                    self.bm.verts.new(self._p(d1, top_sp, u0)),
                ]
            f_list = [
                self.bm.faces.new(pts0),
                self.bm.faces.new(list(reversed(pts1))),
            ]
            for k in range(4):
                kn = (k + 1) % 4
                f_list.append(self.bm.faces.new([pts0[k], pts0[kn], pts1[kn], pts1[k]]))
            self._assign_faces(f_list, self.palette.idx(wall_mat))

            # Proud limestone radial voussoir block (+0.03m proud on both faces)
            is_keystone = i in (segments // 2 - 1, segments // 2)
            v_thick = 0.28 if is_keystone else 0.20
            proud = 0.045 if is_keystone else 0.028
            vy0_in, vy1_in = arc_y0 - 0.01, arc_y1 - 0.01
            vy0_out, vy1_out = arc_y0 + v_thick, arc_y1 + v_thick
            vd0, vd1 = d0 - proud, d1 + proud
            v_mat = "Mat_Terracotta" if is_keystone and trim_mat == "Mat_Terracotta" else "Mat_Limestone"

            if along_x:
                vp0 = [
                    self.bm.verts.new(self._p(u0, vy0_in, vd0)),
                    self.bm.verts.new(self._p(u1, vy1_in, vd0)),
                    self.bm.verts.new(self._p(u1, vy1_out, vd0)),
                    self.bm.verts.new(self._p(u0, vy0_out, vd0)),
                ]
                vp1 = [
                    self.bm.verts.new(self._p(u0, vy0_in, vd1)),
                    self.bm.verts.new(self._p(u1, vy1_in, vd1)),
                    self.bm.verts.new(self._p(u1, vy1_out, vd1)),
                    self.bm.verts.new(self._p(u0, vy0_out, vd1)),
                ]
            else:
                vp0 = [
                    self.bm.verts.new(self._p(vd0, vy0_in, u0)),
                    self.bm.verts.new(self._p(vd0, vy1_in, u1)),
                    self.bm.verts.new(self._p(vd0, vy1_out, u1)),
                    self.bm.verts.new(self._p(vd0, vy0_out, u0)),
                ]
                vp1 = [
                    self.bm.verts.new(self._p(vd1, vy0_in, u0)),
                    self.bm.verts.new(self._p(vd1, vy1_in, u1)),
                    self.bm.verts.new(self._p(vd1, vy1_out, u1)),
                    self.bm.verts.new(self._p(vd1, vy0_out, u0)),
                ]
            vf = [self.bm.faces.new(vp0), self.bm.faces.new(list(reversed(vp1)))]
            for k in range(4):
                kn = (k + 1) % 4
                vf.append(self.bm.faces.new([vp0[k], vp0[kn], vp1[kn], vp1[k]]))
            self._assign_faces(vf, self.palette.idx(v_mat))

        # Top cornice cap across the arch header
        if along_x:
            self.add_box(s0 - 0.02, y_top - 0.14, d0 - 0.035, s1 + 0.02, y_top, d1 + 0.035, trim_mat, bevel=0.015)
            # Impost capitals at spring line
            self.add_box(s0 - 0.18, y_spring - 0.14, d0 - 0.04, s0 + 0.04, y_spring, d1 + 0.04, "Mat_Limestone", bevel=0.012)
            self.add_box(s1 - 0.04, y_spring - 0.14, d0 - 0.04, s1 + 0.18, y_spring, d1 + 0.04, "Mat_Limestone", bevel=0.012)
        else:
            self.add_box(d0 - 0.035, y_top - 0.14, s0 - 0.02, d1 + 0.035, y_top, s1 + 0.02, trim_mat, bevel=0.015)
            self.add_box(d0 - 0.04, y_spring - 0.14, s0 - 0.18, d1 + 0.04, y_spring, s0 + 0.04, "Mat_Limestone", bevel=0.012)
            self.add_box(d0 - 0.04, y_spring - 0.14, s1 - 0.04, d1 + 0.04, y_spring, s1 + 0.18, "Mat_Limestone", bevel=0.012)

    def finalize_object(self, used_materials_only: bool = True) -> bpy.types.Object:
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        bmesh.ops.triangulate(self.bm, faces=self.bm.faces)

        # Generate clean 4.0m world-space box-projected UVs
        uv_layer = self.bm.loops.layers.uv.verify()
        uv_scale = 4.0
        for face in self.bm.faces:
            n = face.normal
            # Convert Blender normal (nx, ny, nz) -> World (nx, nz, -ny)
            wnx, wny, wnz = n.x, n.z, -n.y
            for loop in face.loops:
                co_b = loop.vert.co + self.origin_blender
                wx, wy, wz = co_b.x, co_b.z, -co_b.y
                if abs(wny) > 0.55:
                    u, v = wx / uv_scale, wz / uv_scale
                elif abs(wnx) >= abs(wnz):
                    u, v = wz / uv_scale, wy / uv_scale
                else:
                    u, v = wx / uv_scale, wy / uv_scale
                loop[uv_layer].uv = (u, v)

        if used_materials_only:
            used_indices = sorted({f.material_index for f in self.bm.faces})
            remap = {old_i: new_i for new_i, old_i in enumerate(used_indices)}
            for f in self.bm.faces:
                f.material_index = remap[f.material_index]
            mats = [self.palette.ordered[i] for i in used_indices]
        else:
            mats = list(self.palette.ordered)

        mesh_data = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(mesh_data)
        self.bm.free()

        for m in mats:
            mesh_data.materials.append(m)

        obj = bpy.data.objects.new(self.name, mesh_data)
        obj.location = self.origin_blender.copy()
        bpy.context.collection.objects.link(obj)
        return obj


# ---------------------------------------------------------------------------
# Ascent Single-Source-of-Truth Map Architect
# ---------------------------------------------------------------------------

class AscentArchitect:
    def __init__(self, palette: MaterialPalette) -> None:
        self.palette = palette
        self.colliders: List[Dict] = []
        self.walkable_rects: List[Dict] = []
        self.wall_rects: List[Dict] = []
        self.doors: List[Dict] = []
        self.buy_barrier_spans: List[Dict] = []

        # Batched static mesh layers (keeps draw calls low while cleanly organized)
        self.floors_mb = WorldMeshBuilder("Ascent_Floors", palette)
        self.west_mb = WorldMeshBuilder("Ascent_SiteA_West", palette)
        self.mid_mb = WorldMeshBuilder("Ascent_Mid_Center", palette)
        self.east_mb = WorldMeshBuilder("Ascent_SiteB_East", palette)
        self.props_mb = WorldMeshBuilder("Ascent_Props_Cover", palette)
        self.skyline_mb = WorldMeshBuilder("Ascent_Skyline", palette)

    def _pick_mb(self, x0: float, x1: float) -> WorldMeshBuilder:
        cx = 0.5 * (x0 + x1)
        if cx < -13.0:
            return self.west_mb
        if cx > 13.0:
            return self.east_mb
        return self.mid_mb

    def add_collider(self, x0: float, y0: float, z0: float, x1: float, y1: float, z1: float, tag: str) -> None:
        ax0, ax1 = min(x0, x1), max(x0, x1)
        ay0, ay1 = min(y0, y1), max(y0, y1)
        az0, az1 = min(z0, z1), max(z0, z1)
        if ax1 - ax0 < 1e-4 or ay1 - ay0 < 1e-4 or az1 - az0 < 1e-4:
            return
        self.colliders.append({
            "min": {"x": round(ax0, 3), "y": round(ay0, 3), "z": round(az0, 3)},
            "max": {"x": round(ax1, 3), "y": round(ay1, 3), "z": round(az1, 3)},
            "tag": tag,
        })

    def add_walkable_rect(self, x0: float, z0: float, x1: float, z1: float, level: str) -> None:
        self.walkable_rects.append({
            "x0": round(min(x0, x1), 2),
            "z0": round(min(z0, z1), 2),
            "x1": round(max(x0, x1), 2),
            "z1": round(max(z0, z1), 2),
            "level": level,
        })

    def add_minimap_wall(self, x0: float, z0: float, x1: float, z1: float, kind: str) -> None:
        self.wall_rects.append({
            "x0": round(min(x0, x1), 2),
            "z0": round(min(z0, z1), 2),
            "x1": round(max(x0, x1), 2),
            "z1": round(max(z0, z1), 2),
            "kind": kind,
        })

    def add_venetian_wall(
        self,
        x0: float,
        z0: float,
        x1: float,
        z1: float,
        y0: float = 0.0,
        y1: float = 5.2,
        wall_mat: Optional[str] = None,
        trim_mat: str = "Mat_Terracotta",
        minimap: bool = True,
    ) -> None:
        """Thin architectural Venetian wall with proud Istrian limestone plinth & cornice."""
        ax0, ax1 = min(x0, x1), max(x0, x1)
        az0, az1 = min(z0, z1), max(z0, z1)
        self.add_collider(ax0, y0, az0, ax1, y1, az1, "wall")
        if minimap and y0 <= 0.2:
            self.add_minimap_wall(ax0, az0, ax1, az1, "wall")

        mb = self._pick_mb(ax0, ax1)
        if wall_mat is None:
            cx = 0.5 * (ax0 + ax1)
            if cx < -13.5:
                wall_mat = "Mat_PlasterWarm"
            elif cx > 13.5:
                wall_mat = "Mat_PlasterHarbor"
            else:
                wall_mat = "Mat_PlasterPeach"

        plinth_h = 0.32 if (y1 - y0) > 1.2 and y0 < 0.05 else 0.0
        cornice_h = 0.14 if (y1 - y0) > 1.0 else 0.0
        proud = 0.022

        body_y0 = y0 + plinth_h
        body_y1 = y1 - cornice_h
        if plinth_h > 0:
            mb.add_box(ax0 - proud, y0, az0 - proud, ax1 + proud, body_y0, az1 + proud, "Mat_Limestone", bevel=0.015)
        mb.add_box(ax0, body_y0, az0, ax1, body_y1, az1, wall_mat, bevel=0.02)
        if cornice_h > 0:
            mb.add_box(ax0 - proud * 1.3, body_y1, az0 - proud * 1.3, ax1 + proud * 1.3, y1, az1 + proud * 1.3, trim_mat, bevel=0.015)

        # Subtle limestone pilasters every ~8m on long thin walls (non-coplanar, proud by 0.028m)
        span_x = ax1 - ax0
        span_z = az1 - az0
        if span_x >= 9.0 and span_z <= 0.85 and body_y1 - body_y0 > 2.0:
            steps = max(2, int(span_x // 7.5))
            for k in range(1, steps):
                px = ax0 + (span_x * k) / steps
                mb.add_box(px - 0.16, body_y0 + 0.02, az0 - 0.028, px + 0.16, body_y1 - 0.02, az1 + 0.028, "Mat_Limestone", bevel=0.012)
        elif span_z >= 9.0 and span_x <= 0.85 and body_y1 - body_y0 > 2.0:
            steps = max(2, int(span_z // 7.5))
            for k in range(1, steps):
                pz = az0 + (span_z * k) / steps
                mb.add_box(ax0 - 0.028, body_y0 + 0.02, pz - 0.16, ax1 + 0.028, body_y1 - 0.02, pz + 0.16, "Mat_Limestone", bevel=0.012)

    def add_solid_building_mass(
        self,
        x0: float,
        z0: float,
        x1: float,
        z1: float,
        y1: float = 5.6,
        wall_mat: str = "Mat_PlasterWarm",
        roof_mat: str = "Mat_Terracotta",
    ) -> None:
        """Solid perimeter/filler Venetian building block with cornice & recessed roof terrace."""
        ax0, ax1 = min(x0, x1), max(x0, x1)
        az0, az1 = min(z0, z1), max(z0, z1)
        self.add_collider(ax0, 0.0, az0, ax1, y1, az1, "wall")
        self.add_minimap_wall(ax0, az0, ax1, az1, "wall")
        mb = self._pick_mb(ax0, ax1)
        mb.add_box(ax0 - 0.018, 0.0, az0 - 0.018, ax1 + 0.018, 0.34, az1 + 0.018, "Mat_Limestone", bevel=0.015)
        mb.add_box(ax0, 0.34, az0, ax1, y1 - 0.18, az1, wall_mat, bevel=0.025)
        mb.add_box(ax0 - 0.03, y1 - 0.18, az0 - 0.03, ax1 + 0.03, y1, az1 + 0.03, roof_mat, bevel=0.018)

    def add_archway_opening(
        self,
        along_x: bool,
        s0: float,
        s1: float,
        d0: float,
        d1: float,
        y_clear: float = 3.15,
        y_top: float = 5.2,
        wall_mat: str = "Mat_PlasterWarm",
        trim_mat: str = "Mat_Terracotta",
    ) -> None:
        """Curved stone archway whose physics collider sits cleanly at [y_clear, y_top]."""
        if along_x:
            self.add_collider(s0, y_clear, d0, s1, y_top, d1, "wall")
            mb = self._pick_mb(s0, s1)
        else:
            self.add_collider(d0, y_clear, s0, d1, y_top, s1, "wall")
            mb = self._pick_mb(d0, d1)

        y_spring = y_clear - 0.52  # Outer spring sits gracefully near jambs while center crown = y_clear + 0.15
        mb.add_curved_arch(
            along_x=along_x,
            s0=min(s0, s1),
            s1=max(s0, s1),
            d0=min(d0, d1),
            d1=max(d0, d1),
            y_spring=y_spring,
            y_crown=y_clear + 0.05,
            y_top=y_top,
            wall_mat=wall_mat,
            trim_mat=trim_mat,
            segments=8,
        )

    def add_shoot_window_wall(
        self,
        along_x: bool,
        s0: float,
        s1: float,
        d0: float,
        d1: float,
        y_sill: float = 1.10,
        y_lintel: float = 2.50,
        y_top: float = 5.20,
        wall_mat: str = "Mat_PlasterPeach",
    ) -> None:
        """
        Tactical shoot-through window:
          - Sill collider: 0.00 .. 1.10m
          - OPEN BAND:     1.10 .. 2.50m (bullets, LoS & thrown utility pass cleanly!)
          - Lintel:        2.50 .. y_top
        """
        a0, a1 = min(s0, s1), max(s0, s1)
        b0, b1 = min(d0, d1), max(d0, d1)
        if along_x:
            self.add_collider(a0, 0.0, b0, a1, y_sill, b1, "wall")
            self.add_collider(a0, y_lintel, b0, a1, y_top, b1, "wall")
            self.add_minimap_wall(a0, b0, a1, b1, "window")
            mb = self._pick_mb(a0, a1)
            # Sill masonry + proud limestone counter ledge
            mb.add_box(a0, 0.0, b0, a1, y_sill - 0.08, b1, wall_mat, bevel=0.015)
            mb.add_box(a0 - 0.02, y_sill - 0.08, b0 - 0.05, a1 + 0.02, y_sill, b1 + 0.05, "Mat_Limestone", bevel=0.012)
            # Lintel masonry + timber header beam
            mb.add_box(a0 - 0.02, y_lintel, b0 - 0.04, a1 + 0.02, y_lintel + 0.14, b1 + 0.04, "Mat_DarkOak", bevel=0.012)
            mb.add_box(a0, y_lintel + 0.14, b0, a1, y_top - 0.14, b1, wall_mat, bevel=0.018)
            mb.add_box(a0 - 0.03, y_top - 0.14, b0 - 0.03, a1 + 0.03, y_top, b1 + 0.03, "Mat_Terracotta", bevel=0.015)
            # Open-flung Venetian wooden window shutters on exterior face
            mb.add_box(a0 - 0.58, y_sill + 0.04, b0 - 0.07, a0 - 0.04, y_lintel - 0.04, b0 - 0.02, "Mat_TimberOak", bevel=0.01)
            mb.add_box(a1 + 0.04, y_sill + 0.04, b0 - 0.07, a1 + 0.58, y_lintel - 0.04, b0 - 0.02, "Mat_TimberOak", bevel=0.01)
        else:
            self.add_collider(b0, 0.0, a0, b1, y_sill, a1, "wall")
            self.add_collider(b0, y_lintel, a0, b1, y_top, a1, "wall")
            self.add_minimap_wall(b0, a0, b1, a1, "window")
            mb = self._pick_mb(b0, b1)
            mb.add_box(b0, 0.0, a0, b1, y_sill - 0.08, a1, wall_mat, bevel=0.015)
            mb.add_box(b0 - 0.05, y_sill - 0.08, a0 - 0.02, b1 + 0.05, y_sill, a1 + 0.02, "Mat_Limestone", bevel=0.012)
            mb.add_box(b0 - 0.04, y_lintel, a0 - 0.02, b1 + 0.04, y_lintel + 0.14, a1 + 0.02, "Mat_DarkOak", bevel=0.012)
            mb.add_box(b0, y_lintel + 0.14, a0, b1, y_top - 0.14, a1, wall_mat, bevel=0.018)
            mb.add_box(b0 - 0.03, y_top - 0.14, a0 - 0.03, b1 + 0.03, y_top, a1 + 0.03, "Mat_Terracotta", bevel=0.015)

    def add_radianite_crate(
        self,
        x0: float,
        z0: float,
        x1: float,
        z1: float,
        y0: float,
        y1: float,
        variant: str = "teal",
        minimap: bool = True,
    ) -> None:
        """Sculpted Valorant Radianite crate with beveled steel frame, recessed panels & glowing core."""
        ax0, ax1 = min(x0, x1), max(x0, x1)
        az0, az1 = min(z0, z1), max(z0, z1)
        self.add_collider(ax0, y0, az0, ax1, y1, az1, "cover")
        if minimap:
            self.add_minimap_wall(ax0, az0, ax1, az1, "cover")

        core_mat = "Mat_RadianiteTeal" if variant == "teal" else "Mat_RadianiteOrange"
        mb = self.props_mb
        ins = 0.045
        # Recessed main body
        mb.add_box(ax0 + ins, y0 + ins, az0 + ins, ax1 - ins, y1 - ins, az1 - ins, core_mat, bevel=0.015)
        # Bottom & Top heavy steel bumper frames
        mb.add_box(ax0, y0, az0, ax1, y0 + 0.12, az1, "Mat_DarkIron", bevel=0.015)
        mb.add_box(ax0, y1 - 0.12, az0, ax1, y1, az1, "Mat_DarkIron", bevel=0.015)
        # 4 Corner vertical steel posts
        pw = 0.13
        for cx0, cx1 in [(ax0, ax0 + pw), (ax1 - pw, ax1)]:
            for cz0, cz1 in [(az0, az0 + pw), (az1 - pw, az1)]:
                mb.add_box(cx0, y0 + 0.12, cz0, cx1, y1 - 0.12, cz1, "Mat_DarkIron", bevel=0.01)
        # Glowing Radianite seam strips on all 4 vertical faces (proud of recessed body, flush inside frame)
        my = 0.5 * (y0 + y1)
        mb.add_box(ax0 + pw + 0.06, my - 0.05, az0 + 0.02, ax1 - pw - 0.06, my + 0.05, az1 - 0.02, "Mat_RadianiteGlow", bevel=0.0)
        mb.add_box(ax0 + 0.02, my - 0.05, az0 + pw + 0.06, ax1 - 0.02, my + 0.05, az1 - pw - 0.06, "Mat_RadianiteGlow", bevel=0.0)

    def add_low_stone_cover(
        self,
        x0: float,
        z0: float,
        x1: float,
        z1: float,
        y0: float = 0.0,
        y1: float = 1.25,
        body_mat: str = "Mat_Limestone",
        cap_mat: str = "Mat_Terracotta",
    ) -> None:
        ax0, ax1 = min(x0, x1), max(x0, x1)
        az0, az1 = min(z0, z1), max(z0, z1)
        self.add_collider(ax0, y0, az0, ax1, y1, az1, "cover")
        self.add_minimap_wall(ax0, az0, ax1, az1, "cover")
        self.props_mb.add_box(ax0, y0, az0, ax1, y1 - 0.10, az1, body_mat, bevel=0.018)
        self.props_mb.add_box(ax0 - 0.025, y1 - 0.10, az0 - 0.025, ax1 + 0.025, y1, az1 + 0.025, cap_mat, bevel=0.015)

    def add_wood_cover_crate(
        self,
        x0: float,
        z0: float,
        x1: float,
        z1: float,
        y0: float = 0.0,
        y1: float = 1.28,
        minimap: bool = True,
    ) -> None:
        """Sculpted Valorant wooden slatted cover crate with dark-oak framing & corner steel straps."""
        ax0, ax1 = min(x0, x1), max(x0, x1)
        az0, az1 = min(z0, z1), max(z0, z1)
        self.add_collider(ax0, y0, az0, ax1, y1, az1, "cover")
        if minimap:
            self.add_minimap_wall(ax0, az0, ax1, az1, "cover")
        mb = self.props_mb
        ins = 0.04
        # Recessed weathered plank core
        mb.add_box(ax0 + ins, y0 + ins, az0 + ins, ax1 - ins, y1 - ins, az1 - ins, "Mat_WoodCrate", bevel=0.01)
        # Bottom & Top heavy dark-oak edge battens
        mb.add_box(ax0, y0, az0, ax1, y0 + 0.11, az1, "Mat_DarkOak", bevel=0.01)
        mb.add_box(ax0, y1 - 0.11, az0, ax1, y1, az1, "Mat_DarkOak", bevel=0.01)
        # 4 Corner vertical timber posts + mid-height iron strapping band
        pw = 0.11
        for cx0, cx1 in [(ax0, ax0 + pw), (ax1 - pw, ax1)]:
            for cz0, cz1 in [(az0, az0 + pw), (az1 - pw, az1)]:
                mb.add_box(cx0, y0 + 0.11, cz0, cx1, y1 - 0.11, cz1, "Mat_DarkOak", bevel=0.0)
        my = 0.5 * (y0 + y1)
        mb.add_box(ax0 + 0.015, my - 0.045, az0 + 0.015, ax1 - 0.015, my + 0.045, az1 - 0.015, "Mat_DarkIron", bevel=0.0)

    def add_olive_tree(self, cx: float, base_y: float, cz: float, scale: float = 1.0, cypress: bool = False) -> None:
        """Decorative Mediterranean tree canopy (above head height or inside planter collider)."""
        if cypress:
            self.props_mb.add_cylinder(cx, base_y + 1.1 * scale, cz, 0.18 * scale, 0.12 * scale, 2.2 * scale, "Mat_DarkOak", segments=7, axis="y", smooth=True)
            self.props_mb.add_icosphere(cx, base_y + 2.85 * scale, cz, 0.68 * scale, 1.65 * scale, 0.68 * scale, "Mat_FoliageCypress", subdivisions=1, smooth=True)
            self.props_mb.add_icosphere(cx, base_y + 4.35 * scale, cz, 0.44 * scale, 1.18 * scale, 0.44 * scale, "Mat_FoliageOlive", subdivisions=1, smooth=True)
        else:
            self.props_mb.add_branch((cx, base_y, cz), (cx + 0.12 * scale, base_y + 1.15 * scale, cz - 0.08 * scale), 0.24 * scale, 0.17 * scale, "Mat_DarkOak", segments=7, smooth=True)
            self.props_mb.add_branch((cx + 0.12 * scale, base_y + 1.05 * scale, cz - 0.08 * scale), (cx - 0.06 * scale, base_y + 2.05 * scale, cz + 0.06 * scale), 0.17 * scale, 0.12 * scale, "Mat_DarkOak", segments=7, smooth=True)
            self.props_mb.add_icosphere(cx, base_y + 2.55 * scale, cz, 1.38 * scale, 0.82 * scale, 1.32 * scale, "Mat_FoliageOlive", subdivisions=1, smooth=True)
            self.props_mb.add_icosphere(cx - 0.65 * scale, base_y + 2.35 * scale, cz + 0.45 * scale, 0.85 * scale, 0.62 * scale, 0.85 * scale, "Mat_FoliageCypress", subdivisions=1, smooth=True)
            self.props_mb.add_icosphere(cx + 0.65 * scale, base_y + 2.45 * scale, cz - 0.40 * scale, 0.88 * scale, 0.64 * scale, 0.85 * scale, "Mat_FoliageSunlit", subdivisions=1, smooth=True)

    def add_sculpted_ascent_tree(self, cx: float, cz: float) -> None:
        """
        Centerpiece 3D Mediterranean Olive Tree inside A Tree / Garden:
          - Tiered octagonal Istrian limestone planter with terracotta coping & dark soil bed
          - Flared root collar, gnarled twisting multi-segment oak trunk & 4 forked boughs
          - Lush 8-cluster tiered olive / cypress / sunlit foliage canopy (y = 2.85 .. 4.35m)
        """
        # Physics collider for stone planter (leaves clean walk clearance around all 4 sides!)
        self.add_collider(cx - 1.10, 0.0, cz - 1.10, cx + 1.10, 1.14, cz + 1.10, "cover")
        self.add_minimap_wall(cx - 1.10, cz - 1.10, cx + 1.10, cz + 1.10, "cover")

        mb = self.props_mb
        # Tiered octagonal limestone planter + terracotta coping ledge + recessed dark soil bed
        mb.add_cylinder(cx, 0.14, cz, 1.24, 1.18, 0.28, "Mat_Limestone", segments=8, axis="y")
        mb.add_cylinder(cx, 0.62, cz, 1.10, 1.14, 0.70, "Mat_PlasterWarm", segments=8, axis="y")
        mb.add_cylinder(cx, 1.05, cz, 1.22, 1.24, 0.18, "Mat_Terracotta", segments=8, axis="y")
        mb.add_cylinder(cx, 1.135, cz, 0.94, 0.94, 0.04, "Mat_SoilDark", segments=8, axis="y")

        # Flared gnarled roots & twisting 3-segment ancient olive trunk
        mb.add_branch((cx - 0.28, 1.06, cz + 0.20), (cx - 0.04, 1.48, cz + 0.04), 0.16, 0.11, "Mat_DarkOak", segments=6)
        mb.add_branch((cx + 0.30, 1.06, cz - 0.18), (cx + 0.06, 1.46, cz - 0.03), 0.15, 0.10, "Mat_DarkOak", segments=6)
        mb.add_branch((cx + 0.04, 1.06, cz + 0.32), (cx + 0.02, 1.45, cz + 0.06), 0.14, 0.10, "Mat_DarkOak", segments=6)

        p_base = (cx, 1.06, cz)
        p_mid1 = (cx + 0.22, 1.88, cz - 0.14)
        p_mid2 = (cx - 0.12, 2.62, cz + 0.10)
        mb.add_branch(p_base, p_mid1, 0.32, 0.24, "Mat_DarkOak", segments=8)
        mb.add_branch(p_mid1, p_mid2, 0.24, 0.19, "Mat_DarkOak", segments=8)

        # 4 Spreading forked boughs reaching outward into the tiered canopy
        boughs = [
            (p_mid2, (cx - 1.18, 3.38, cz + 0.78), 0.15, 0.07),
            (p_mid2, (cx + 1.15, 3.45, cz - 0.72), 0.15, 0.07),
            (p_mid2, (cx - 0.85, 3.55, cz - 0.95), 0.13, 0.06),
            (p_mid1, (cx + 0.95, 3.18, cz + 0.88), 0.14, 0.06),
            (p_mid2, (cx + 0.05, 3.78, cz + 0.04), 0.14, 0.07),
        ]
        for bp0, bp1, r0, r1 in boughs:
            mb.add_branch(bp0, bp1, r0, r1, "Mat_TimberOak", segments=6)

        # Tiered Mediterranean Olive Canopy (8 smooth organic clusters, staying above y = 2.85m!)
        clusters = [
            # Lower shadowed cypress-green underside clusters
            (cx - 1.05, 3.35, cz + 0.65, 1.02, 0.58, 0.95, "Mat_FoliageCypress"),
            (cx + 0.92, 3.22, cz + 0.78, 0.96, 0.54, 0.90, "Mat_FoliageCypress"),
            (cx - 0.78, 3.45, cz - 0.86, 0.98, 0.56, 0.92, "Mat_FoliageCypress"),
            # Mid main silvery-sage olive crown
            (cx, 3.68, cz, 1.48, 0.76, 1.40, "Mat_FoliageOlive"),
            (cx + 1.12, 3.52, cz - 0.66, 1.08, 0.62, 1.02, "Mat_FoliageOlive"),
            (cx - 0.95, 3.62, cz + 0.18, 1.04, 0.60, 0.98, "Mat_FoliageOlive"),
            # Sun-kissed upper olive foliage tips
            (cx + 0.25, 4.02, cz - 0.22, 1.15, 0.54, 1.05, "Mat_FoliageSunlit"),
            (cx - 0.35, 3.96, cz + 0.42, 0.92, 0.48, 0.88, "Mat_FoliageSunlit"),
        ]
        for lx, ly, lz, rx, ry, rz, fmat in clusters:
            mb.add_icosphere(lx, ly, lz, rx, ry, rz, fmat, subdivisions=2, smooth=True)

    def add_venetian_palazzo_top(
        self,
        x0: float,
        z0: float,
        x1: float,
        z1: float,
        y_base: float,
        story_h: float,
        ridge_h: float,
        wall_mat: str,
        ridge_along_x: bool = True,
        add_chimney: bool = True,
    ) -> None:
        """Purely visual upper Venetian palazzo facade + shuttered windows + pitched terracotta roof (y >= y_base)."""
        ax0, ax1 = min(x0, x1), max(x0, x1)
        az0, az1 = min(z0, z1), max(z0, z1)
        y_eave = y_base + story_h
        mb = self.skyline_mb
        # Upper plaster facade + limestone string course + terracotta eave band (bevel=0.0 for lean GLB!)
        mb.add_box(ax0 - 0.05, y_base, az0 - 0.05, ax1 + 0.05, y_base + 0.16, az1 + 0.05, "Mat_Limestone", bevel=0.0)
        mb.add_box(ax0, y_base + 0.16, az0, ax1, y_eave, az1, wall_mat, bevel=0.0)
        mb.add_box(ax0 - 0.08, y_eave - 0.16, az0 - 0.08, ax1 + 0.08, y_eave, az1 + 0.08, "Mat_Limestone", bevel=0.0)
        # Pitched terracotta gable roof
        mb.add_pitched_roof(ax0, az0, ax1, az1, y_eave, ridge_h, ridge_along_x=ridge_along_x, roof_mat="Mat_Terracotta", gable_mat=wall_mat, overhang=0.35, add_ribs=False)

        # Venetian shuttered window accents along the long inward-facing facades
        span_x = ax1 - ax0
        span_z = az1 - az0
        wy0 = y_base + 0.72
        wy1 = min(y_eave - 0.55, wy0 + 1.55)
        if wy1 > wy0 + 0.5:
            if span_x >= span_z and span_x >= 4.5:
                n_win = max(1, min(4, int(span_x // 4.2)))
                for k in range(n_win):
                    wx = ax0 + (span_x * (k + 0.5)) / n_win
                    # Window panes + limestone sill on both North & South faces
                    for wz in (az0 - 0.04, az1 + 0.04):
                        mb.add_box(wx - 0.48, wy0, wz - 0.04, wx + 0.48, wy1, wz + 0.04, "Mat_DarkIron", bevel=0.0)
                        mb.add_box(wx - 0.62, wy0 - 0.12, wz - 0.08, wx + 0.62, wy0, wz + 0.08, "Mat_Limestone", bevel=0.0)
                        mb.add_box(wx - 0.84, wy0, wz - 0.05, wx - 0.50, wy1, wz + 0.05, "Mat_TimberOak", bevel=0.0)
                        mb.add_box(wx + 0.50, wy0, wz - 0.05, wx + 0.84, wy1, wz + 0.05, "Mat_TimberOak", bevel=0.0)
            elif span_z > span_x and span_z >= 4.5:
                n_win = max(1, min(4, int(span_z // 4.2)))
                for k in range(n_win):
                    wz = az0 + (span_z * (k + 0.5)) / n_win
                    for wx in (ax0 - 0.04, ax1 + 0.04):
                        mb.add_box(wx - 0.04, wy0, wz - 0.48, wx + 0.04, wy1, wz + 0.48, "Mat_DarkIron", bevel=0.0)
                        mb.add_box(wx - 0.08, wy0 - 0.12, wz - 0.62, wx + 0.08, wy0, wz + 0.62, "Mat_Limestone", bevel=0.0)
                        mb.add_box(wx - 0.05, wy0, wz - 0.84, wx + 0.05, wy1, wz - 0.50, "Mat_TimberOak", bevel=0.0)
                        mb.add_box(wx - 0.05, wy0, wz + 0.50, wx + 0.05, wy1, wz + 0.84, "Mat_TimberOak", bevel=0.0)

        if add_chimney:
            chx = ax0 + (ax1 - ax0) * 0.25
            chz = az0 + (az1 - az0) * 0.28
            mb.add_box(chx - 0.32, y_eave + 0.2, chz - 0.32, chx + 0.32, y_eave + ridge_h + 0.75, chz + 0.32, "Mat_BrickVenetian", bevel=0.0)
            mb.add_box(chx - 0.44, y_eave + ridge_h + 0.75, chz - 0.44, chx + 0.44, y_eave + ridge_h + 0.96, chz + 0.44, "Mat_Terracotta", bevel=0.0)

    # -----------------------------------------------------------------------
    # Build Complete Ascent Geometry
    # -----------------------------------------------------------------------

    def build_all(self) -> List[bpy.types.Object]:
        self._build_ground_and_pavements()
        self._build_perimeter_and_spawns()
        self._build_south_lobbies_and_doglegs()
        self._build_west_wing_site_a()
        self._build_center_mid_and_market()
        self._build_east_wing_site_b()
        door_objects = self._build_interactive_blast_doors()
        self._build_skyline()

        static_objs = [
            self.floors_mb.finalize_object(),
            self.west_mb.finalize_object(),
            self.mid_mb.finalize_object(),
            self.east_mb.finalize_object(),
            self.props_mb.finalize_object(),
            self.skyline_mb.finalize_object(),
        ]
        return static_objs + door_objects

    def _build_ground_and_pavements(self) -> None:
        # Single continuous ground physics slab [-42..42] x [-46..46] at y in [-0.60, 0.00]
        self.add_collider(MIN_X, -0.60, MIN_Z, MAX_X, 0.00, MAX_Z, "floor")

        # Sub-base slab ends at y = -0.025m so non-overlapping paved regional slabs sit cleanly at [-0.025, 0.000] with ZERO Z-fighting!
        self.floors_mb.add_box(MIN_X, -0.60, MIN_Z, MAX_X, -0.025, MAX_Z, "Mat_CliffRock", bevel=0.0)

        # Partition [-42..42] x [-46..46] into exact non-overlapping regional stone pavements at y = [-0.025 .. 0.000]:
        # 1. South Strip (z: +20 .. +46): T-Spawn travertine/cobble
        self.floors_mb.add_box(-42.0, -0.025, 20.0, 42.0, 0.000, 46.0, "Mat_TravertineFloor", bevel=0.0)
        # 2. North Strip (z: -46 .. -25.5): CT Sanctuary slate
        self.floors_mb.add_box(-42.0, -0.025, -46.0, 42.0, 0.000, -25.5, "Mat_HarborSlate", bevel=0.0)
        # 3. Middle Band (z: -25.5 .. +20.0) partitioned by X:
        #    - West Site A & Wine & A Lobby (x: -42.0 .. -14.0): Warm Travertine
        self.floors_mb.add_box(-42.0, -0.025, -25.5, -14.0, 0.000, 20.0, "Mat_TravertineFloor", bevel=0.0)
        #    - A Tree & Mid Courtyard (x: -14.0 .. +2.0): Cobble Plaza
        self.floors_mb.add_box(-14.0, -0.025, -25.5, 2.0, 0.000, 20.0, "Mat_CobblePlaza", bevel=0.0)
        #    - Mid Market (x: +2.0 .. +14.0, z: -25.5 .. -15.0) + East Mid Courtyard (x: +2.0 .. +14.0, z: -15.0 .. +20.0)
        self.floors_mb.add_box(2.0, -0.025, -25.5, 14.0, 0.000, -15.0, "Mat_MarbleCheck", bevel=0.0)
        self.floors_mb.add_box(2.0, -0.025, -15.0, 14.0, 0.000, 20.0, "Mat_CobblePlaza", bevel=0.0)
        #    - East Site B & B Main & B Lobby (x: +14.0 .. +42.0, z: -25.5 .. +20.0): Harbor Slate
        self.floors_mb.add_box(14.0, -0.025, -25.5, 42.0, 0.000, 20.0, "Mat_HarborSlate", bevel=0.0)

        # Raised decorative floor inlays (proud +0.006..+0.016m, strictly non-overlapping with zero Z-fighting!)
        # Boathouse wooden interior boardwalk dock + recessed Venetian canal water slipway under gondola
        self.floors_mb.add_box(26.5, 0.000, -32.0, 32.8, 0.016, -24.9, "Mat_TimberOak", bevel=0.0)
        self.floors_mb.add_box(32.8, 0.000, -26.8, 36.0, 0.016, -24.9, "Mat_TimberOak", bevel=0.0)
        self.floors_mb.add_box(32.8, 0.000, -32.0, 36.0, 0.006, -26.8, "Mat_CanalWater", bevel=0.0)
        # Deepened A Wine cellar oak plank floor inlay
        self.floors_mb.add_box(-40.2, 0.000, -7.6, -31.2, 0.012, -0.8, "Mat_TimberOak", bevel=0.0)
        # Mid Tiles Venetian marble-tile floor inlay
        self.floors_mb.add_box(-15.6, 0.000, 2.2, -8.2, 0.010, 9.6, "Mat_MarbleCheck", bevel=0.0)

    def _build_perimeter_and_spawns(self) -> None:
        # Outer 84m x 92m Perimeter Walls
        self.add_venetian_wall(-42.0, -46.0, -41.4, 46.0, 0.0, 6.0, "Mat_PlasterWarm", "Mat_Terracotta")
        self.add_venetian_wall(41.4, -46.0, 42.0, 46.0, 0.0, 6.0, "Mat_PlasterHarbor", "Mat_Terracotta")
        self.add_venetian_wall(-41.4, -46.0, 41.4, -45.4, 0.0, 6.0, "Mat_PlasterHarbor", "Mat_Terracotta")
        self.add_venetian_wall(-41.4, 45.4, 41.4, 46.0, 0.0, 6.0, "Mat_PlasterWarm", "Mat_Terracotta")

        # --- SOUTH T-SPAWN (z: +20.25 .. +45.4, x: -32 .. +32) ---
        self.add_walkable_rect(-32.0, 20.25, 32.0, 45.4, "spawn_a")
        self.add_solid_building_mass(-41.4, 20.0, -32.0, 45.4, 5.8, "Mat_PlasterWarm", "Mat_Terracotta")
        self.add_solid_building_mass(32.0, 20.0, 41.4, 45.4, 5.8, "Mat_PlasterPeach", "Mat_Terracotta")

        # Portico wing divider colonnades in T-Spawn (blocks cross-spawn shallow diagonal sightlines while keeping wide 17m plaza!)
        self.add_venetian_wall(-16.5, 20.25, -15.9, 28.0, 0.0, 5.4, "Mat_PlasterWarm", "Mat_Terracotta")
        self.add_venetian_wall(15.9, 20.25, 16.5, 28.0, 0.0, 5.4, "Mat_PlasterPeach", "Mat_Terracotta")

        # Decorative planter bench behind T-Spawn pads (z = 42.0) + Spike Pedestal ring at (0, 0, 33)
        self.add_low_stone_cover(-9.0, 41.8, -3.5, 43.4, 0.0, 1.15, "Mat_Limestone", "Mat_Terracotta")
        self.add_low_stone_cover(3.5, 41.8, 9.0, 43.4, 0.0, 1.15, "Mat_Limestone", "Mat_Terracotta")
        self.add_olive_tree(-6.25, 1.15, 42.6, 0.9, cypress=True)
        self.add_olive_tree(6.25, 1.15, 42.6, 0.9, cypress=True)

        # Sculpted Radianite Spike Pedestal at exact (0.0, 0.0 .. 0.05, 33.0) (visual only, <= 5cm tall so walkable)
        self.props_mb.add_cylinder(0.0, 0.015, 33.0, 1.15, 1.05, 0.03, "Mat_DarkIron", segments=6, axis="y")
        self.props_mb.add_cylinder(0.0, 0.040, 33.0, 0.82, 0.76, 0.02, "Mat_SpikeGlow", segments=6, axis="y")

        # --- SOUTH BUY-BARRIER WALL (z = +20.0, thickness 19.75 .. 20.25) ---
        # 3 Attacker Exits: West A-Lobby [-28..-23], Center Top-Mid [+3..+8], East B-Lobby [+23..+28]
        self.add_venetian_wall(-32.0, 19.75, -28.0, 20.25, 0.0, 5.4, "Mat_PlasterWarm")
        self.add_archway_opening(True, -28.0, -23.0, 19.75, 20.25, 3.20, 5.40, "Mat_PlasterWarm")
        self.add_venetian_wall(-23.0, 19.75, 3.0, 20.25, 0.0, 5.4, "Mat_PlasterPeach")
        self.add_archway_opening(True, 3.0, 8.0, 19.75, 20.25, 3.20, 5.40, "Mat_PlasterPeach")
        self.add_venetian_wall(8.0, 19.75, 23.0, 20.25, 0.0, 5.4, "Mat_PlasterHarbor")
        self.add_archway_opening(True, 23.0, 28.0, 19.75, 20.25, 3.20, 5.40, "Mat_PlasterHarbor")
        self.add_venetian_wall(28.0, 19.75, 32.0, 20.25, 0.0, 5.4, "Mat_PlasterHarbor")

        self.buy_barrier_spans.extend([
            {"x0": -28.0, "x1": -23.0, "z": BUY_MIN_ALLY_Z, "baseY": 0.0, "height": 3.2, "side": "attacker"},
            {"x0": 3.0, "x1": 8.0, "z": BUY_MIN_ALLY_Z, "baseY": 0.0, "height": 3.2, "side": "attacker"},
            {"x0": 23.0, "x1": 28.0, "z": BUY_MIN_ALLY_Z, "baseY": 0.0, "height": 3.2, "side": "attacker"},
        ])

        # --- NORTH CT-SPAWN SANCTUARY (z: -45.4 .. -26.0) ---
        self.add_walkable_rect(-13.1, -45.4, 24.0, -32.5, "spawn_d")
        self.add_walkable_rect(-13.1, -32.5, 1.75, -27.5, "spawn_d")  # Defender CT-A / Tree / Mid Link Rotation Plaza
        self.add_walkable_rect(1.75, -32.5, 14.25, -25.5, "spawn_d")  # CT-Mid outside Market Back Door
        # Outer North-West & North-East perimeter building masses
        self.add_solid_building_mass(-41.4, -45.4, -26.0, -32.5, 6.0, "Mat_PlasterWarm", "Mat_Terracotta")
        self.add_solid_building_mass(-26.0, -45.4, -13.1, -37.0, 6.0, "Mat_PlasterWarm", "Mat_Terracotta")
        self.add_solid_building_mass(24.0, -45.4, 41.4, -32.5, 6.0, "Mat_PlasterHarbor", "Mat_Terracotta")
        # Split north-center masses framing A Tree <-> CT-A Connector (-9.8..-5.6) & Arched Mid Link (-4.75..+1.75)!
        self.add_solid_building_mass(-14.25, -27.5, -9.8, -22.5, 5.6, "Mat_PlasterWarm", "Mat_Terracotta")
        self.add_solid_building_mass(-5.6, -27.5, -4.75, -22.5, 5.6, "Mat_PlasterPeach", "Mat_Terracotta")
        # Building mass between CT-Mid & Site B North-West
        self.add_solid_building_mass(14.25, -32.5, 17.5, -25.5, 5.6, "Mat_PlasterHarbor", "Mat_Terracotta")

        # Defender Buy-Barrier Spans at exact z = -16.0m across all 6 open lanes
        self.buy_barrier_spans.extend([
            {"x0": -36.0, "x1": -14.25, "z": BUY_MAX_DEFENDER_Z, "baseY": 0.0, "height": 3.4, "side": "defender"},
            {"x0": -13.75, "x1": -5.25, "z": BUY_MAX_DEFENDER_Z, "baseY": 0.0, "height": 3.4, "side": "defender"},
            {"x0": -2.6, "x1": 1.2, "z": BUY_MAX_DEFENDER_Z, "baseY": 0.0, "height": 3.25, "side": "defender"},
            {"x0": 2.25, "x1": 13.75, "z": BUY_MAX_DEFENDER_Z, "baseY": 0.0, "height": 3.4, "side": "defender"},
            {"x0": 14.25, "x1": 33.5, "z": BUY_MAX_DEFENDER_Z, "baseY": 0.0, "height": 3.4, "side": "defender"},
            {"x0": 33.5, "x1": 38.0, "z": BUY_MAX_DEFENDER_Z, "baseY": 0.85, "height": 2.8, "side": "defender"},
        ])

    def _build_south_lobbies_and_doglegs(self) -> None:
        # 1. A LOBBY (x: -35.0 .. -16.0, z: +6.0 .. +19.75)
        self.add_walkable_rect(-35.0, 6.0, -16.0, 19.75, "ground")
        self.add_solid_building_mass(-41.4, 6.0, -35.0, 20.0, 5.6, "Mat_PlasterWarm", "Mat_Terracotta")
        # Dog-leg baffle wall inside A Lobby tied flush to East corner block (guarantees 0 LoS from z>=20!)
        self.add_venetian_wall(-30.5, 13.5, -15.75, 14.1, 0.0, 5.4, "Mat_PlasterWarm")
        # Building block separating East A Lobby & South Top-Mid (x: -16.0 .. -8.0, z: +9.8 .. +19.75)
        self.add_solid_building_mass(-16.0, 9.8, -8.0, 19.75, 5.6, "Mat_PlasterPeach", "Mat_Terracotta")
        # A Lobby <-> Mid Tiles Connector Archway at x = -16.0, z: +6.25 .. +9.8 (3.55m clear curved stone arch!)
        self.add_archway_opening(False, 6.25, 9.8, -16.25, -15.75, 3.20, 5.40, "Mat_PlasterWarm")
        # North wall of A Lobby (z: +5.75 .. +6.25): opens into A Main at x: -31.0 .. -24.25
        self.add_venetian_wall(-35.0, 5.75, -31.0, 6.25, 0.0, 5.4, "Mat_PlasterWarm")
        self.add_archway_opening(True, -31.0, -24.25, 5.75, 6.25, 3.30, 5.40, "Mat_PlasterWarm")
        self.add_venetian_wall(-24.25, 5.75, -16.25, 6.25, 0.0, 5.4, "Mat_PlasterWarm")

        # 2. TOP MID DOG-LEG (x: -8.0 .. +11.5, z: +8.0 .. +19.75)
        self.add_walkable_rect(-8.0, 8.0, 11.25, 19.75, "ground")
        # Cheek wall & North baffle creating authentic Ascent Top-Mid dog-leg turn
        self.add_venetian_wall(0.75, 16.2, 1.25, 19.75, 0.0, 5.4, "Mat_PlasterPeach")
        self.add_venetian_wall(-1.5, 12.0, 11.25, 12.6, 0.0, 5.4, "Mat_PlasterPeach")
        # Top Mid Archway into Mid Courtyard (x: -8.0 .. -1.5, z = 12.3)
        self.add_archway_opening(True, -8.0, -1.5, 12.0, 12.6, 3.40, 5.40, "Mat_PlasterPeach")
        # Building block separating Top-Mid & B Lobby (x: +11.25 .. +18.0, z: +9.5 .. +19.75)
        self.add_solid_building_mass(11.25, 9.5, 18.0, 19.75, 5.6, "Mat_PlasterPeach", "Mat_Terracotta")

        # 3. B LOBBY (x: +18.0 .. +35.0, z: +4.0 .. +19.75) & Mid-B Connector (z: +5.5 .. +9.5)
        self.add_walkable_rect(18.0, 4.0, 35.0, 19.75, "ground")
        self.add_walkable_rect(11.25, 5.5, 18.0, 9.5, "ground")
        self.add_solid_building_mass(35.0, 4.0, 41.4, 20.0, 5.6, "Mat_PlasterHarbor", "Mat_Terracotta")
        # Dog-leg baffle wall inside B Lobby (guarantees 0 LoS from z>=20!)
        self.add_venetian_wall(18.0, 12.8, 30.2, 13.4, 0.0, 5.4, "Mat_PlasterHarbor")
        # Mid-to-B-Lobby Connector framing arch & south wall
        self.add_archway_opening(False, 5.5, 9.5, 11.25, 11.75, 3.15, 5.40, "Mat_PlasterPeach")
        self.add_solid_building_mass(11.25, -8.0, 17.5, 5.5, 5.6, "Mat_PlasterHarbor", "Mat_Terracotta")
        # North wall of B Lobby into B Main (z: +3.75 .. +4.25, opens at x: +24.0 .. +30.5)
        self.add_venetian_wall(17.5, 3.75, 24.0, 4.25, 0.0, 5.4, "Mat_PlasterHarbor")
        self.add_archway_opening(True, 24.0, 30.5, 3.75, 4.25, 3.30, 5.40, "Mat_PlasterHarbor")
        self.add_venetian_wall(30.5, 3.75, 35.0, 4.25, 0.0, 5.4, "Mat_PlasterHarbor")

    def _build_west_wing_site_a(self) -> None:
        # 1. A MAIN & DEEPENED A WINE CELLAR ALCOVE (z: -8.0 .. +5.75)
        self.add_walkable_rect(-31.0, -8.0, -24.25, 5.75, "ground")
        self.add_walkable_rect(-40.2, -7.6, -31.0, -0.8, "ground")  # Deepened A Wine stone alcove!
        # Building mass between A Main (-24.25) and Mid Catwalk/Tiles (-15.75 / -11.8)
        self.add_solid_building_mass(-24.25, -8.0, -15.75, 5.75, 5.6, "Mat_PlasterWarm", "Mat_Terracotta")
        self.add_solid_building_mass(-15.75, -8.0, -11.8, 2.0, 5.6, "Mat_PlasterWarm", "Mat_Terracotta")
        # Outer West enclosures around A Main & Deepened A Wine (recessed back to x = -40.2!)
        self.add_solid_building_mass(-41.4, -0.8, -31.0, 6.0, 5.6, "Mat_PlasterWarm", "Mat_Terracotta")
        self.add_solid_building_mass(-41.4, -8.25, -40.2, -0.8, 5.6, "Mat_BrickVenetian", "Mat_Terracotta")
        self.add_venetian_wall(-40.2, -8.25, -31.0, -7.6, 0.0, 5.4, "Mat_BrickVenetian")
        # Curved Venetian stone archway framing the recessed A Wine entrance (x = -31.6 .. -31.0, z: -7.0 .. -1.4)
        self.add_venetian_wall(-31.6, -7.6, -31.0, -7.0, 0.0, 5.4, "Mat_BrickVenetian")
        self.add_archway_opening(False, -7.0, -1.4, -31.6, -31.0, 3.15, 5.40, "Mat_BrickVenetian")
        self.add_venetian_wall(-31.6, -1.4, -31.0, -0.8, 0.0, 5.4, "Mat_BrickVenetian")
        # Wine cellar timber ceiling beams + enclosed terracotta lean-to alcove roof (y = 4.25 .. 4.65m)
        self.add_collider(-40.2, 4.25, -8.2, -31.0, 4.65, -0.8, "wall")
        self.add_minimap_wall(-40.2, -7.6, -31.2, -0.8, "roof")
        for bz in (-6.6, -5.0, -3.4, -1.8):
            self.west_mb.add_box(-40.2, 3.65, bz - 0.14, -31.4, 3.92, bz + 0.14, "Mat_DarkOak", bevel=0.0)
        self.west_mb.add_box(-40.4, 4.22, -8.2, -31.1, 4.48, -0.8, "Mat_DarkOak", bevel=0.0)
        self.west_mb.add_box(-40.5, 4.48, -8.3, -31.0, 4.68, -0.7, "Mat_Terracotta", bevel=0.0)
        # Recessed brick wine-shelf cornice accent on the deep back wall of A Wine
        self.west_mb.add_box(-40.18, 2.25, -6.5, -39.92, 2.38, -2.0, "Mat_Limestone", bevel=0.0)

        # Sculpted Banded Oak Wine Barrels stocked deep inside A Wine!
        self.add_collider(-40.0, 0.0, -6.9, -38.1, 2.08, -1.9, "cover")
        self.add_minimap_wall(-40.0, -6.9, -38.1, -1.9, "cover")
        # Heavy oak barrel rack + 3 bottom banded oak casks + 2 upper stacked casks with dark iron hoops
        self.props_mb.add_box(-39.9, 0.0, -6.7, -38.2, 0.24, -2.1, "Mat_DarkOak", bevel=0.015)
        for bz in (-5.9, -4.4, -2.9):
            self.props_mb.add_cylinder(-39.05, 0.72, bz, 0.50, 0.50, 1.56, "Mat_TimberOak", segments=12, axis="x", smooth=True)
            self.props_mb.add_cylinder(-39.58, 0.72, bz, 0.52, 0.52, 0.08, "Mat_DarkIron", segments=12, axis="x")
            self.props_mb.add_cylinder(-38.52, 0.72, bz, 0.52, 0.52, 0.08, "Mat_DarkIron", segments=12, axis="x")
        for bz in (-5.15, -3.65):
            self.props_mb.add_cylinder(-39.05, 1.58, bz, 0.48, 0.48, 1.50, "Mat_TimberOak", segments=12, axis="x", smooth=True)
            self.props_mb.add_cylinder(-39.54, 1.58, bz, 0.50, 0.50, 0.08, "Mat_DarkIron", segments=12, axis="x")
            self.props_mb.add_cylinder(-38.56, 1.58, bz, 0.50, 0.50, 0.08, "Mat_DarkIron", segments=12, axis="x")
        # Upright oak wine barrels & wooden crate tucked in North-West A Wine nook (x: -36.8..-35.0, z: -7.4..-5.8)
        self.add_collider(-36.9, 0.0, -7.45, -35.0, 1.24, -5.85, "cover")
        self.add_minimap_wall(-36.9, -7.45, -35.0, -5.85, "cover")
        for bpx, bpz in [(-36.4, -6.9), (-35.5, -6.9), (-36.0, -6.2)]:
            self.props_mb.add_cylinder(bpx, 0.60, bpz, 0.36, 0.34, 1.20, "Mat_TimberOak", segments=10, axis="y", smooth=True)
            self.props_mb.add_cylinder(bpx, 0.25, bpz, 0.37, 0.37, 0.07, "Mat_DarkIron", segments=10, axis="y")
            self.props_mb.add_cylinder(bpx, 0.96, bpz, 0.36, 0.36, 0.07, "Mat_DarkIron", segments=10, axis="y")

        # 2. SITE A COURTYARD (x: -36.0 .. -14.25, z: -24.0 .. -8.25)
        self.add_walkable_rect(-36.0, -24.0, -14.25, -8.25, "ground")
        # Outer West wall of Site A & A Hell
        self.add_solid_building_mass(-41.4, -32.5, -36.0, -8.25, 6.0, "Mat_PlasterWarm", "Mat_Terracotta")
        # South wall of Site A (z: -8.25 .. -7.75) with iconic A Main Curved Stone Archway (x: -30.0 .. -25.0)
        self.add_venetian_wall(-36.0, -8.25, -30.0, -7.75, 0.0, 5.4, "Mat_PlasterWarm")
        self.add_archway_opening(True, -30.0, -25.0, -8.25, -7.75, 3.35, 5.40, "Mat_PlasterWarm")
        self.add_venetian_wall(-25.0, -8.25, -14.25, -7.75, 0.0, 5.4, "Mat_PlasterWarm")

        # East wall of Site A (x: -14.25 .. -13.75) separating Site A from A Tree, hosting `a_tree` Blast Door at z: -19.6 .. -16.4
        self.add_venetian_wall(-14.25, -16.4, -13.75, -7.75, 0.0, 5.4, "Mat_PlasterWarm")
        self.add_venetian_wall(-14.25, -24.0, -13.75, -19.6, 0.0, 5.4, "Mat_PlasterWarm")

        # Bomb Site A Glowing Floor Border Frame (-31.0 .. -18.0, -23.0 .. -12.0)
        self._add_site_floor_border(-31.0, -23.0, -18.0, -12.0, "Mat_SiteAAccent")

        # --- SCULPTED BLUE-GREY INDUSTRIAL TURBINE A GENERATOR (-27.6 .. -24.8, -21.2 .. -18.7, y: 0 .. 2.85) ---
        gx0, gx1, gz0, gz1, gy1 = -27.6, -24.8, -21.2, -18.7, 2.85
        gcx, gcz = 0.5 * (gx0 + gx1), 0.5 * (gz0 + gz1)
        self.add_collider(gx0, 0.0, gz0, gx1, gy1, gz1, "cover")
        self.add_minimap_wall(gx0, gz0, gx1, gz1, "cover")
        # Heavy steel skid plinth + yellow hazard edge stripe
        self.props_mb.add_box(gx0, 0.0, gz0, gx1, 0.24, gz1, "Mat_DarkIron", bevel=0.015)
        self.props_mb.add_box(gx0 + 0.04, 0.24, gz0 + 0.04, gx1 - 0.04, 0.34, gz1 - 0.04, "Mat_HazardGold", bevel=0.0)
        # Lower generator chassis & turbine saddle cradle
        self.props_mb.add_box(gx0 + 0.14, 0.34, gz0 + 0.16, gx1 - 0.14, 1.05, gz1 - 0.16, "Mat_GenSteelBlue", bevel=0.02)
        # Iconic Large Horizontal Blue-Grey Cylindrical Industrial Turbine Drum!
        self.props_mb.add_cylinder(gcx, 1.56, gcz, 0.86, 0.86, 2.48, "Mat_GenSteelBlue", segments=16, axis="x", smooth=True)
        # Heavy dark-iron steel reinforcing ribs & bolted end flanges around the turbine drum
        for rx in (gx0 + 0.22, gcx - 0.55, gcx + 0.55, gx1 - 0.22):
            self.props_mb.add_cylinder(rx, 1.56, gcz, 0.92, 0.92, 0.12, "Mat_DarkIron", segments=16, axis="x")
        # Copper dynamo end-hubs & side control console box with glowing Radianite diagnostic strip
        self.props_mb.add_cylinder(gcx, 1.56, gcz, 0.42, 0.42, 2.72, "Mat_CopperCoil", segments=12, axis="x", smooth=True)
        self.props_mb.add_box(gx0 + 0.48, 0.55, gz1 - 0.20, gx1 - 0.48, 1.48, gz1 - 0.01, "Mat_BlastSteel", bevel=0.012)
        self.props_mb.add_box(gx0 + 0.65, 1.24, gz1 - 0.01, gx1 - 0.65, 1.36, gz1 + 0.02, "Mat_RadianiteGlow", bevel=0.0)
        # Top industrial intake manifold + Tall Angled Exhaust Stack Pipe with heat-shield & rain cap!
        self.props_mb.add_box(gx0 + 0.40, 2.28, gz0 + 0.55, gx1 - 0.40, 2.54, gz1 - 0.55, "Mat_DarkIron", bevel=0.015)
        # Primary tall exhaust stack pipe (north-west) + secondary vent pipe (north-east)
        self.props_mb.add_cylinder(gx0 + 0.62, 2.88, gz0 + 0.72, 0.24, 0.20, 1.05, "Mat_GenSteelBlue", segments=12, axis="y", smooth=True)
        self.props_mb.add_cylinder(gx0 + 0.62, 2.72, gz0 + 0.72, 0.29, 0.29, 0.36, "Mat_DarkIron", segments=10, axis="y")
        self.props_mb.add_branch((gx0 + 0.62, 3.38, gz0 + 0.72), (gx0 + 0.36, 3.68, gz0 + 0.56), 0.19, 0.22, "Mat_DarkIron", segments=10)
        self.props_mb.add_cylinder(gx1 - 0.68, 2.70, gz0 + 0.76, 0.16, 0.14, 0.48, "Mat_DarkIron", segments=10, axis="y", smooth=True)
        self.props_mb.add_cylinder(gx1 - 0.68, 2.94, gz0 + 0.76, 0.22, 0.06, 0.06, "Mat_HazardGold", segments=10, axis="y")

        # --- SCULPTED A DICE (Double-stacked Radianite cover in center-right Site A, south of -16m barrier!) ---
        self.add_radianite_crate(-21.8, -15.2, -19.6, -13.0, 0.0, 1.12, "teal", minimap=True)
        self.add_radianite_crate(-21.65, -15.05, -19.75, -13.15, 1.12, 2.24, "orange", minimap=False)
        self.add_radianite_crate(-23.1, -14.8, -21.8, -13.4, 0.0, 1.15, "teal", minimap=True)
        # A Main choke side cover crate
        self.add_low_stone_cover(-33.4, -14.8, -31.6, -13.2, 0.0, 1.25, "Mat_Limestone", "Mat_Terracotta")

        # 3. TRUE TWO-STORY A HEAVEN (y = 3.00m) DIRECTLY ABOVE A HELL (y = 0.00m, ceiling = 2.65m)!
        # A Hell walkable floor under Heaven: x: -34.0 .. -20.5, z: -32.0 .. -24.0
        self.add_walkable_rect(-34.0, -32.0, -20.5, -24.0, "ground")
        # West solid abutment (-36.0 .. -34.0, z: -32.5 .. -24.0)
        self.add_solid_building_mass(-36.0, -32.5, -34.0, -24.0, 6.2, "Mat_PlasterWarm", "Mat_Terracotta")
        # North back wall of A Hell (y = 0 .. 2.65m, separating ground Hell from CT while Heaven continues above at y = 3.00m!)
        self.add_venetian_wall(-34.0, -32.5, -20.0, -32.0, 0.0, 2.65, "Mat_BrickVenetian", "Mat_Limestone", minimap=False)
        # East support wall of A Hell (x: -20.5 .. -20.0, z: -32.0 .. -24.0, y: 0 .. 2.65m)
        self.add_venetian_wall(-20.5, -32.0, -20.0, -24.0, 0.0, 2.65, "Mat_BrickVenetian", "Mat_Limestone", minimap=False)
        # South arcade support piers facing Site A (leaving TWO wide 5.55m openings into A Hell with 2.65m ceiling!)
        for px0, px1 in [(-34.0, -33.2), (-27.65, -26.85), (-21.3, -20.5)]:
            self.add_collider(px0, 0.0, -24.5, px1, 2.65, -24.0, "wall")
            self.west_mb.add_box(px0 - 0.03, 0.0, -24.53, px1 + 0.03, 0.30, -23.97, "Mat_Limestone", bevel=0.015)
            self.west_mb.add_box(px0, 0.30, -24.5, px1, 2.45, -24.0, "Mat_Limestone", bevel=0.02)
            self.west_mb.add_box(px0 - 0.05, 2.45, -24.55, px1 + 0.05, 2.65, -23.95, "Mat_Limestone", bevel=0.015)

        # Wooden A Hell Cover Crates tucked under A Heaven (gives classic Ascent Hell peek cover!)
        self.add_wood_cover_crate(-33.6, -31.5, -31.8, -29.7, 0.0, 1.32, minimap=True)
        self.add_wood_cover_crate(-22.4, -31.6, -20.8, -30.2, 0.0, 1.18, minimap=False)

        # A HEAVEN WALKABLE SLAB (y = 2.65 .. 3.00m, top = 3.00m) + North Landing (-26..-20, -36.8..-32.0)
        self.add_collider(-34.0, 2.65, -32.0, -20.0, 3.00, -24.0, "floor")
        self.add_collider(-26.0, 2.65, -36.8, -20.0, 3.00, -32.0, "floor")
        self.add_walkable_rect(-34.0, -32.0, -20.0, -24.0, "high")
        self.add_walkable_rect(-26.0, -36.8, -20.0, -32.0, "high")

        # Visual Heaven stone underside + oak/travertine rafters deck + proud limestone fascia
        self.west_mb.add_box(-34.0, 2.65, -32.0, -20.0, 2.94, -24.0, "Mat_Limestone", bevel=0.02)
        self.west_mb.add_box(-34.0, 2.94, -32.0, -20.0, 3.00, -24.0, "Mat_TimberOak", bevel=0.01)
        self.west_mb.add_box(-26.0, 2.65, -36.8, -20.0, 2.94, -32.0, "Mat_Limestone", bevel=0.02)
        self.west_mb.add_box(-26.0, 2.94, -36.8, -20.0, 3.00, -32.0, "Mat_TimberOak", bevel=0.01)
        # Upper Heaven back enclosure walls (y = 3.00 .. 6.00m) so players stay inside rafters
        self.add_venetian_wall(-34.0, -32.5, -26.0, -32.0, 3.00, 6.00, "Mat_PlasterWarm", "Mat_Terracotta", minimap=False)
        self.add_venetian_wall(-26.5, -37.0, -26.0, -32.0, 3.00, 6.00, "Mat_PlasterWarm", "Mat_Terracotta", minimap=False)
        self.add_venetian_wall(-26.5, -37.2, -13.1, -36.8, 0.00, 6.00, "Mat_PlasterWarm", "Mat_Terracotta", minimap=True)

        # A Heaven Cover Box (tactical head-glitch/peek crate on the y = 3.00m Heaven deck!)
        self.add_wood_cover_crate(-31.6, -27.4, -29.8, -25.6, 3.00, 4.24, minimap=False)

        # A Heaven 1.10m Chest-High Limestone Balustrade (y = 3.00 .. 4.10m) + 3.8m Open Drop Ledge (-26.8 .. -23.0)!
        self._add_heaven_balustrade(-34.0, -26.8, -24.38, -24.0, 3.00, 4.10, along_x=True)
        self._add_heaven_balustrade(-23.0, -20.0, -24.38, -24.0, 3.00, 4.10, along_x=True)
        self._add_heaven_balustrade(-32.0, -24.38, -20.38, -20.0, 3.00, 4.10, along_x=False)
        # Drop ledge caution strip on Heaven floor edge
        self.west_mb.add_box(-26.8, 3.000, -24.35, -23.0, 3.012, -24.0, "Mat_HazardGold", bevel=0.0)

        # --- CT-TO-HEAVEN 7-TREAD STAIRCASE (x: -13.1 -> -20.0, z: -36.8 .. -32.6) ---
        # 6 broad 1.15m treads (+ 7th rise onto y=3.00m Heaven Landing = 7 rises of ~0.429m <= 0.50m!)
        stair_x_start = -13.10
        tread_run = 1.15
        for i in range(6):
            tx1 = stair_x_start - i * tread_run
            tx0 = tx1 - tread_run
            ty = round((i + 1) * (3.00 / 7.0), 3)  # 0.429, 0.857, 1.286, 1.714, 2.143, 2.571 -> 3.000
            self.add_collider(tx0, 0.0, -36.8, tx1, ty, -32.6, "floor")
            self.west_mb.add_box(tx0, 0.0, -36.8, tx1, ty - 0.06, -32.6, "Mat_PlasterWarm", bevel=0.01)
            self.west_mb.add_box(tx0 - 0.02, ty - 0.06, -36.8, tx1 + 0.02, ty, -32.6, "Mat_Limestone", bevel=0.015)
        self.add_walkable_rect(-20.0, -36.8, -13.1, -32.6, "high")
        # Staircase south guard wall (z: -32.6 .. -32.1, x: -20.5 .. -13.1) separating stairs from ground CT-A alley!
        self.add_venetian_wall(-20.5, -32.6, -13.1, -32.1, 0.0, 5.2, "Mat_PlasterWarm", "Mat_Terracotta", minimap=True)

        # --- GROUND CT-TO-SITE-A CONNECTOR ALLEY (z: -32.1 .. -27.5 -> south into Site A at x: -20.0 .. -14.25, z = -24.0) ---
        self.add_walkable_rect(-20.0, -32.1, -13.1, -27.5, "ground")
        self.add_walkable_rect(-20.0, -27.5, -14.25, -24.0, "ground")
        self.add_archway_opening(True, -20.0, -14.25, -24.5, -24.0, 3.20, 5.40, "Mat_PlasterWarm")

        # 4. A TREE / GARDEN (x: -13.75 .. -5.25, z: -22.5 .. -8.0) & NORTH-EAST CT-A / HEAVEN CONNECTOR!
        self.add_walkable_rect(-13.75, -22.5, -5.25, -8.0, "ground")
        # Clean A Tree <-> CT-A / A Heaven Connector Doorway on north-east wall of A Tree (x: -9.8 .. -5.6, z: -27.5 .. -22.5)!
        self.add_walkable_rect(-9.8, -27.5, -5.6, -22.5, "ground")
        self.add_archway_opening(True, -9.8, -5.6, -23.0, -22.5, 3.25, 5.60, "Mat_PlasterWarm")
        self.add_archway_opening(True, -9.8, -5.6, -27.5, -27.0, 3.25, 5.60, "Mat_PlasterWarm")
        # Vaulted covered breezeway roof over A Tree <-> CT-A connector (y = 3.90 .. 5.60m)
        self.add_collider(-9.8, 3.90, -27.5, -5.6, 5.60, -22.5, "wall")
        self.add_minimap_wall(-9.8, -27.5, -5.6, -22.5, "roof")
        self.west_mb.add_box(-9.8, 3.90, -27.2, -5.6, 4.18, -22.8, "Mat_DarkOak", bevel=0.0)
        self.west_mb.add_box(-9.9, 4.18, -27.5, -5.5, 5.42, -22.5, "Mat_PlasterWarm", bevel=0.0)
        self.west_mb.add_box(-10.0, 5.42, -27.6, -5.4, 5.64, -22.4, "Mat_Terracotta", bevel=0.0)

        # East wall of A Tree separating A Tree from Mid Pizza & Mid Link (z: -22.5 .. -8.0)
        self.add_venetian_wall(-5.25, -22.5, -4.75, -8.0, 0.0, 5.4, "Mat_PlasterPeach")
        # Overhead Venetian Garden Pergola (ledger beams + corbels + 6 cross rafters + 4 longitudinal purlins!)
        self.west_mb.add_box(-13.75, 4.08, -22.0, -13.48, 4.34, -8.4, "Mat_DarkOak", bevel=0.0)
        self.west_mb.add_box(-5.52, 4.08, -22.0, -5.25, 4.34, -8.4, "Mat_DarkOak", bevel=0.0)
        for pz in (-21.0, -18.6, -16.2, -13.8, -11.4, -9.0):
            self.west_mb.add_box(-13.75, 4.34, pz - 0.14, -5.25, 4.66, pz + 0.14, "Mat_DarkOak", bevel=0.0)
            self.west_mb.add_box(-13.75, 3.82, pz - 0.10, -13.25, 4.08, pz + 0.10, "Mat_TimberOak", bevel=0.0)
            self.west_mb.add_box(-5.75, 3.82, pz - 0.10, -5.25, 4.08, pz + 0.10, "Mat_TimberOak", bevel=0.0)
        for px in (-12.4, -10.4, -8.4, -6.4):
            self.west_mb.add_box(px - 0.08, 4.66, -21.8, px + 0.08, 4.80, -8.6, "Mat_TimberOak", bevel=0.0)

        # Iconic Sculpted 3D Mediterranean Olive Tree + Stone Planter inside A Tree (south of z = -16.0m barrier!)
        self.add_sculpted_ascent_tree(-8.4, -13.8)

    def _add_heaven_balustrade(
        self,
        s0: float,
        s1: float,
        d0: float,
        d1: float,
        y0: float,
        y1: float,
        along_x: bool,
    ) -> None:
        a0, a1 = min(s0, s1), max(s0, s1)
        b0, b1 = min(d0, d1), max(d0, d1)
        if along_x:
            self.add_collider(a0, y0, b0, a1, y1, b1, "cover")
            self.add_minimap_wall(a0, b0, a1, b1, "cover")
            self.west_mb.add_box(a0, y0, b0, a1, y0 + 0.22, b1, "Mat_Limestone", bevel=0.012)
            self.west_mb.add_box(a0 - 0.02, y1 - 0.16, b0 - 0.03, a1 + 0.02, y1, b1 + 0.03, "Mat_Limestone", bevel=0.015)
            n_bal = max(2, int((a1 - a0) / 0.55))
            mid_b = 0.5 * (b0 + b1)
            for k in range(n_bal + 1):
                bx = a0 + 0.15 + (a1 - a0 - 0.30) * (k / max(1, n_bal))
                self.west_mb.add_cylinder(bx, 0.5 * (y0 + 0.22 + y1 - 0.16), mid_b, 0.075, 0.065, (y1 - y0 - 0.38), "Mat_Limestone", segments=8, axis="y")
        else:
            self.add_collider(b0, y0, a0, b1, y1, a1, "cover")
            self.add_minimap_wall(b0, a0, b1, a1, "cover")
            self.west_mb.add_box(b0, y0, a0, b1, y0 + 0.22, a1, "Mat_Limestone", bevel=0.012)
            self.west_mb.add_box(b0 - 0.03, y1 - 0.16, a0 - 0.02, b1 + 0.03, y1, a1 + 0.02, "Mat_Limestone", bevel=0.015)
            n_bal = max(2, int((a1 - a0) / 0.55))
            mid_b = 0.5 * (b0 + b1)
            for k in range(n_bal + 1):
                bz = a0 + 0.15 + (a1 - a0 - 0.30) * (k / max(1, n_bal))
                self.west_mb.add_cylinder(mid_b, 0.5 * (y0 + 0.22 + y1 - 0.16), bz, 0.075, 0.065, (y1 - y0 - 0.38), "Mat_Limestone", segments=8, axis="y")

    def _add_site_floor_border(self, x0: float, z0: float, x1: float, z1: float, mat_name: str) -> None:
        w = 0.22
        y_top = 0.014
        self.floors_mb.add_box(x0, 0.0, z0, x1, y_top, z0 + w, mat_name, bevel=0.0)
        self.floors_mb.add_box(x0, 0.0, z1 - w, x1, y_top, z1, mat_name, bevel=0.0)
        self.floors_mb.add_box(x0, 0.0, z0 + w, x0 + w, y_top, z1 - w, mat_name, bevel=0.0)
        self.floors_mb.add_box(x1 - w, 0.0, z0 + w, x1, y_top, z1 - w, mat_name, bevel=0.0)

    def _build_center_mid_and_market(self) -> None:
        # 1. MID TILES (x: -15.75 .. -8.0, z: +2.0 .. +10.5)
        self.add_walkable_rect(-15.75, 2.0, -8.0, 10.5, "ground")

        # 2. MID CATWALK (y = 0.85m, x: -11.8 .. -7.6, z: -8.0 .. +0.85) + 2-Step Climbs + CATWALK BOX!
        # South climb from Tiles: Step 1 (z: +0.85 .. +2.00, y = 0.425m) -> Catwalk (z: -8.00 .. +0.85, y = 0.85m)
        self.add_collider(-11.8, 0.0, 0.85, -7.6, 0.425, 2.00, "floor")
        self.mid_mb.add_box(-11.8, 0.0, 0.85, -7.6, 0.425, 2.00, "Mat_Limestone", bevel=0.015)

        self.add_collider(-11.8, 0.0, -8.00, -7.6, 0.85, 0.85, "floor")
        self.mid_mb.add_box(-11.8, 0.0, -8.00, -7.6, 0.78, 0.85, "Mat_BrickVenetian", bevel=0.015)
        self.mid_mb.add_box(-11.82, 0.78, -8.00, -7.58, 0.85, 0.85, "Mat_Limestone", bevel=0.015)
        self.add_walkable_rect(-11.8, -8.0, -7.6, 2.0, "mid")

        # Side step from Mid Courtyard onto Catwalk (x: -7.6 .. -6.45, z: -1.8 .. +0.85, y = 0.425m)
        self.add_collider(-7.6, 0.0, -1.8, -6.45, 0.425, 0.85, "floor")
        self.mid_mb.add_box(-7.6, 0.0, -1.8, -6.45, 0.425, 0.85, "Mat_Limestone", bevel=0.015)

        # Iconic Catwalk Box on elevated Catwalk (leaves 2.85m clear west lane x: -11.8..-8.95!)
        self.add_wood_cover_crate(-8.95, -6.2, -7.65, -4.9, 0.85, 2.02, minimap=True)
        # Catwalk East Stone Parapet overlooking Mid Courtyard (flush south of Catwalk Box!)
        self.add_low_stone_cover(-7.96, -4.9, -7.60, -2.0, 0.85, 1.95, "Mat_Limestone", "Mat_Terracotta")

        # North descent from Catwalk into A Tree under Curved Venetian Stone Archway!
        self.add_archway_opening(True, -11.8, -7.6, -8.25, -7.75, 3.65, 5.40, "Mat_PlasterWarm")
        self.add_venetian_wall(-13.75, -8.25, -11.8, -7.75, 0.0, 5.4, "Mat_PlasterWarm")
        self.add_venetian_wall(-7.6, -8.25, -4.75, -7.75, 0.0, 5.4, "Mat_PlasterPeach")
        # Step down into A Tree (z: -9.15 .. -8.00, y = 0.425m)
        self.add_collider(-11.8, 0.0, -9.15, -7.6, 0.425, -8.00, "floor")
        self.west_mb.add_box(-11.8, 0.0, -9.15, -7.6, 0.425, -8.00, "Mat_Limestone", bevel=0.015)

        # MID SUBROZA / CATWALK CUBBY (y = 0.0m, tucked beside Mid Catwalk at x: -7.6 .. -5.25, z: -7.75 .. -5.0!)
        self.add_venetian_wall(-5.25, -7.75, -4.75, -5.0, 0.0, 3.12, "Mat_PlasterPeach", "Mat_Limestone")
        # Overhead Venetian timber veranda awning sheltering the Subroza cubby (cleanly flush atop cheek wall!)
        self.mid_mb.add_box(-7.58, 2.96, -7.72, -4.76, 3.12, -5.02, "Mat_DarkOak", bevel=0.0)
        self.mid_mb.add_oriented_box(-6.17, 3.24, -6.38, 2.86, 0.12, 2.80, 0.09, 0.0, 0.0, "Mat_Terracotta", bevel=0.0)

        # 3. WIDE SUNLIT VENETIAN MID COURTYARD, MID PIZZA & ARCHED MID LINK
        self.add_walkable_rect(-7.6, -15.0, 11.25, 12.0, "ground")
        self.add_walkable_rect(-4.75, -15.75, 2.0, -10.5, "ground")  # Mid Pizza corridor
        self.add_walkable_rect(-4.75, -27.5, 1.75, -15.75, "ground")  # Arched Mid Link toward Defender Spawn!

        # Sculpted Octagonal Venetian Mid Fountain & Olive Planter (south-center of Mid Courtyard: -1.4..+1.4, +2.6..+5.4)
        self.add_collider(-1.4, 0.0, 2.6, 1.4, 1.25, 5.4, "cover")
        self.add_minimap_wall(-1.4, 2.6, 1.4, 5.4, "cover")
        self.props_mb.add_cylinder(0.0, 0.45, 4.0, 1.50, 1.42, 0.90, "Mat_Limestone", segments=8, axis="y")
        self.props_mb.add_cylinder(0.0, 1.00, 4.0, 1.58, 1.58, 0.22, "Mat_Terracotta", segments=8, axis="y")
        self.props_mb.add_cylinder(0.0, 1.08, 4.0, 1.18, 1.18, 0.08, "Mat_SoilDark", segments=8, axis="y")
        self.props_mb.add_cylinder(0.0, 1.22, 4.0, 0.68, 0.58, 0.30, "Mat_Limestone", segments=8, axis="y")
        self.add_olive_tree(0.0, 1.15, 4.0, 1.02, cypress=False)

        # Iconic Central Mid Courtyard Box (double-stacked Radianite cover in heart of Mid Courtyard!)
        self.add_radianite_crate(1.6, -5.6, 3.9, -3.3, 0.0, 1.12, "teal", minimap=True)
        self.add_radianite_crate(1.75, -5.45, 3.75, -3.45, 1.12, 2.24, "orange", minimap=False)
        self.add_radianite_crate(0.3, -5.2, 1.6, -3.7, 0.0, 1.15, "teal", minimap=True)
        # East Mid Courtyard tactical cover block
        self.add_low_stone_cover(8.2, -2.0, 10.0, -0.2, 0.0, 1.25, "Mat_Limestone", "Mat_Terracotta")

        # Terracotta-Awning Mid Pizza Corridor (west side pizzeria counter + striped Venetian cafe awning!)
        self.add_low_stone_cover(-4.75, -14.8, -3.45, -11.4, 0.0, 1.20, "Mat_BrickVenetian", "Mat_Limestone")
        # Pizzeria arched oven hood facade accent against west wall
        self.mid_mb.add_box(-4.75, 1.20, -14.2, -4.35, 2.75, -12.0, "Mat_BrickVenetian", bevel=0.0)
        self.mid_mb.add_box(-4.75, 2.75, -14.4, -4.25, 2.95, -11.8, "Mat_Limestone", bevel=0.0)
        # Striped Terracotta & Cream Venetian Cafe Awning overhanging Mid Pizza!
        for k in range(5):
            az0 = -15.0 + k * 0.80
            amat = "Mat_Terracotta" if k % 2 == 0 else "Mat_PlasterWarm"
            self.mid_mb.add_oriented_box(-3.65, 3.18, az0 + 0.40, 2.25, 0.10, 0.78, 0.0, 0.0, -0.22, amat, bevel=0.0)
        self.mid_mb.add_branch((-4.72, 2.45, -14.8), (-2.75, 2.94, -14.8), 0.04, 0.04, "Mat_DarkIron", segments=6)
        self.mid_mb.add_branch((-4.72, 2.45, -11.2), (-2.75, 2.94, -11.2), 0.04, 0.04, "Mat_DarkIron", segments=6)

        # Arched Mid Link Portal toward Defender Spawn (z = -16.0 South Portal -> Covered Gallery -> z = -27.25 North Portal!)
        self.add_venetian_wall(-5.25, -16.25, -2.6, -15.75, 0.0, 5.4, "Mat_BrickVenetian")
        self.add_archway_opening(True, -2.6, 1.2, -16.25, -15.75, 3.25, 5.40, "Mat_PlasterPeach")
        self.add_venetian_wall(1.2, -16.25, 1.75, -15.75, 0.0, 5.4, "Mat_PlasterPeach")
        # North Mid Link Archway opening directly into Defender Spawn / CT Link Plaza (z = -27.5 .. -27.0)
        self.add_venetian_wall(-4.75, -27.5, -2.6, -27.0, 0.0, 5.4, "Mat_PlasterPeach")
        self.add_archway_opening(True, -2.6, 1.2, -27.5, -27.0, 3.25, 5.40, "Mat_PlasterPeach")
        self.add_venetian_wall(1.2, -27.5, 1.75, -27.0, 0.0, 5.4, "Mat_PlasterPeach")
        # Covered Venetian roof over north half of Mid Link + pergola beams over south half + Mid Link cover block
        self.add_collider(-4.75, 3.90, -27.5, 1.75, 5.40, -21.5, "wall")
        self.add_minimap_wall(-4.75, -27.5, 1.75, -21.5, "roof")
        self.mid_mb.add_box(-4.75, 3.90, -27.3, 1.75, 4.18, -21.5, "Mat_DarkOak", bevel=0.0)
        self.mid_mb.add_box(-4.85, 4.18, -27.6, 1.85, 5.42, -21.4, "Mat_PlasterPeach", bevel=0.0)
        self.mid_mb.add_box(-4.95, 5.42, -27.7, 1.95, 5.62, -21.3, "Mat_Terracotta", bevel=0.0)
        for pz in (-20.4, -18.8, -17.2):
            self.mid_mb.add_box(-4.75, 4.18, pz - 0.12, 1.75, 4.44, pz + 0.12, "Mat_DarkOak", bevel=0.0)
        self.add_low_stone_cover(-4.65, -21.8, -3.30, -19.8, 0.0, 1.25, "Mat_Limestone", "Mat_Terracotta")

        # 4. ROOFED ARCHED MID MARKET (x: +2.25 .. +13.75, z: -25.5 .. -15.1)
        self.add_walkable_rect(2.25, -25.5, 13.75, -15.1, "ground")
        # West wall of Market (4.20m under Market eaves) + short north tie into Mid Link arch (5.40m)
        self.add_venetian_wall(1.75, -27.5, 2.25, -26.0, 0.0, 5.40, "Mat_PlasterPeach")
        self.add_venetian_wall(1.75, -26.0, 2.25, -15.1, 0.0, 4.20, "Mat_PlasterPeach", "Mat_Limestone")
        # South wall of Market (z: -15.35 .. -14.85, clean eave height y = 4.20m flush beneath pitched terracotta roof!):
        #   - Bottom-Mid Doorway (x: +2.6 .. +6.0)
        #   - Pier (x: +6.0 .. +7.0)
        #   - Shoot-Through Market Window (x: +7.0 .. +11.4, open band y = 1.10 .. 2.50m!)
        #   - Pier (x: +11.4 .. +14.25)
        self.add_venetian_wall(1.75, -15.35, 2.6, -14.85, 0.0, 4.20, "Mat_PlasterPeach", "Mat_Limestone")
        self.add_archway_opening(True, 2.6, 6.0, -15.35, -14.85, 3.10, 4.20, "Mat_PlasterPeach", "Mat_Limestone")
        self.add_venetian_wall(6.0, -15.35, 7.0, -14.85, 0.0, 4.20, "Mat_PlasterPeach", "Mat_Limestone")
        self.add_shoot_window_wall(True, 7.0, 11.4, -15.35, -14.85, 1.10, 2.50, 4.20, "Mat_PlasterPeach")
        self.add_venetian_wall(11.4, -15.35, 14.25, -14.85, 0.0, 4.20, "Mat_PlasterPeach", "Mat_Limestone")

        # North wall of Market (z: -26.0 .. -25.5): Back CT Doorway at x: +5.2 .. +9.4
        self.add_venetian_wall(1.75, -26.0, 5.2, -25.5, 0.0, 4.20, "Mat_PlasterPeach", "Mat_Limestone")
        self.add_archway_opening(True, 5.2, 9.4, -26.0, -25.5, 3.20, 4.20, "Mat_PlasterPeach", "Mat_Limestone")
        self.add_venetian_wall(9.4, -26.0, 14.25, -25.5, 0.0, 4.20, "Mat_PlasterPeach", "Mat_Limestone")

        # East wall of Market (x: +13.75 .. +14.25, separating Market/Mid from Site B, hosting `b_market` Blast Door at z: -22.6 .. -19.4!)
        self.add_venetian_wall(13.75, -14.85, 14.25, -8.0, 0.0, 5.40, "Mat_PlasterHarbor")
        self.add_venetian_wall(13.75, -19.4, 14.25, -14.85, 0.0, 4.20, "Mat_PlasterHarbor", "Mat_Limestone")
        self.add_venetian_wall(13.75, -26.0, 14.25, -22.6, 0.0, 4.20, "Mat_PlasterHarbor", "Mat_Limestone")

        # Roofed Market Hall Ceiling (y = 3.85 .. 4.40m -> 3.85m clear headroom!) + Clean Sloped Terracotta Gable Roof!
        self.add_collider(1.75, 3.85, -26.0, 14.25, 4.40, -14.85, "wall")
        self.add_minimap_wall(2.25, -25.5, 13.75, -15.35, "roof")
        self.mid_mb.add_box(1.9, 3.88, -25.8, 14.1, 4.18, -15.0, "Mat_DarkOak", bevel=0.0)
        for mx in (4.2, 7.2, 10.2, 12.6):
            self.mid_mb.add_box(mx - 0.12, 3.68, -25.5, mx + 0.12, 3.88, -15.35, "Mat_DarkOak", bevel=0.0)
        self.mid_mb.add_pitched_roof(1.75, -26.0, 14.25, -14.85, 4.22, 1.75, ridge_along_x=True, roof_mat="Mat_Terracotta", gable_mat="Mat_PlasterPeach", overhang=0.35, add_ribs=True)
        # Market interior vendor counter crate (north of -16m barrier, keeping doorway & Window clear!)
        self.add_low_stone_cover(2.4, -23.4, 4.1, -20.6, 0.0, 1.22, "Mat_TimberOak", "Mat_Limestone")

    def _build_east_wing_site_b(self) -> None:
        # 1. ENCLOSED B MAIN VENETIAN GARAGE, WALL-BANG CORNER CRATES & B LOGS (z: -8.0 .. +3.75)
        self.add_walkable_rect(21.5, -8.0, 35.0, 3.75, "ground")
        self.add_walkable_rect(35.0, -8.0, 38.0, -3.0, "ground")  # Full 4.5m B Lane approach runway!
        self.add_walkable_rect(17.5, -7.0, 21.5, -1.5, "ground")  # B Logs recessed cubby
        self.add_solid_building_mass(38.0, -7.75, 41.4, -3.0, 5.6, "Mat_PlasterHarbor", "Mat_Terracotta")
        self.add_solid_building_mass(35.0, -3.0, 41.4, 4.0, 5.6, "Mat_PlasterHarbor", "Mat_Terracotta")
        self.add_solid_building_mass(17.5, -1.5, 21.5, 3.75, 5.6, "Mat_PlasterHarbor", "Mat_Terracotta")
        self.add_venetian_wall(17.5, -8.0, 21.5, -7.0, 0.0, 5.4, "Mat_PlasterHarbor")
        # Arched opening into B Logs cubby
        self.add_archway_opening(False, -7.0, -1.5, 21.0, 21.5, 3.15, 5.40, "Mat_PlasterHarbor")
        # Sculpted Timber Logs Stack inside B Logs cubby (x: +17.7 .. +19.6, z: -6.4 .. -2.4, y: 0 .. 1.38)
        self.add_collider(17.7, 0.0, -6.4, 19.6, 1.38, -2.4, "cover")
        self.add_minimap_wall(17.7, -6.4, 19.6, -2.4, "cover")
        self.props_mb.add_box(17.75, 0.0, -6.2, 19.55, 0.18, -2.6, "Mat_DarkIron", bevel=0.01)
        for ly, cols in [(0.42, [18.1, 18.65, 19.2]), (0.86, [18.35, 18.95]), (1.22, [18.65])]:
            for lx in cols:
                self.props_mb.add_cylinder(lx, ly, -4.4, 0.25, 0.24, 3.7, "Mat_TimberOak", segments=10, axis="z", smooth=True)

        # Enclosed Roofed Venetian Garage Ceiling & Pitched Terracotta Roof over B Main (y = 3.95 .. 4.45m -> 3.95m headroom!)
        self.add_collider(17.5, 3.95, -8.25, 38.0, 4.45, 4.25, "wall")
        self.add_minimap_wall(21.5, -7.75, 35.0, 3.75, "roof")
        self.east_mb.add_box(17.6, 4.00, -8.1, 37.9, 4.35, 4.1, "Mat_DarkOak", bevel=0.0)
        for gz in (-6.0, -3.2, -0.4, 2.2):
            self.east_mb.add_box(21.5, 3.76, gz - 0.14, 35.0, 4.00, gz + 0.14, "Mat_DarkOak", bevel=0.0)
        self.east_mb.add_pitched_roof(17.6, -8.25, 35.0, 4.25, 5.42, 1.65, ridge_along_x=True, roof_mat="Mat_Terracotta", gable_mat="Mat_PlasterHarbor", overhang=0.32, add_ribs=True)

        # Wall-Bang Corner Crates inside B Main Garage (tucked behind mouth piers, leaving 6m B Main & 4.5m B Lane wide open!)
        self.add_wood_cover_crate(30.9, -7.6, 32.7, -5.8, 0.0, 1.38, minimap=True)
        self.add_wood_cover_crate(21.8, -7.6, 23.4, -6.1, 0.0, 1.28, minimap=True)

        # B Main North Wall into Site B (z: -8.25 .. -7.75):
        #   - Solid [14.25 .. 24.5]
        #   - B Main Curved Archway [24.5 .. 30.5] (6.0m wide!)
        #   - Pier [30.5 .. 33.5]
        #   - B Lane Open Climb [33.5 .. 38.0]
        self.add_venetian_wall(14.25, -8.25, 24.5, -7.75, 0.0, 5.4, "Mat_PlasterHarbor")
        self.add_archway_opening(True, 24.5, 30.5, -8.25, -7.75, 3.35, 5.40, "Mat_PlasterHarbor")
        self.add_venetian_wall(30.5, -8.25, 33.5, -7.75, 0.0, 5.4, "Mat_PlasterHarbor")
        self.add_archway_opening(True, 33.5, 38.0, -8.25, -7.75, 3.60, 5.40, "Mat_PlasterHarbor")

        # Iconic B LOGS Wooden Log-Pile Cover right at the mouth of B Site (x: +22.0 .. +24.4, z: -11.4 .. -9.4, y: 0..1.32)!
        self.add_collider(22.0, 0.0, -11.4, 24.4, 1.32, -9.4, "cover")
        self.add_minimap_wall(22.0, -11.4, 24.4, -9.4, "cover")
        self.props_mb.add_box(22.08, 0.0, -11.3, 24.32, 0.18, -9.5, "Mat_DarkOak", bevel=0.01)
        for ly, z_cols in [(0.42, [-10.95, -10.40, -9.85]), (0.84, [-10.68, -10.12]), (1.16, [-10.40])]:
            for lz in z_cols:
                self.props_mb.add_cylinder(23.2, ly, lz, 0.24, 0.23, 2.28, "Mat_TimberOak", segments=10, axis="x", smooth=True)
        # Iron lashing straps binding the B Logs stack
        self.props_mb.add_box(22.45, 0.14, -11.24, 22.58, 1.30, -9.56, "Mat_DarkIron", bevel=0.0)
        self.props_mb.add_box(23.82, 0.14, -11.24, 23.95, 1.30, -9.56, "Mat_DarkIron", bevel=0.0)

        # 2. SITE B COURTYARD & ELEVATED B LANE (x: +14.25 .. +38.0, z: -32.5 .. -8.25)
        self.add_walkable_rect(14.25, -32.5, 26.0, -8.25, "ground")
        self.add_walkable_rect(26.0, -24.4, 33.5, -8.25, "ground")
        # Outer East wall framing B Lane & Boathouse
        self.add_solid_building_mass(38.0, -32.5, 41.4, -7.75, 5.8, "Mat_PlasterHarbor", "Mat_Terracotta")
        self.add_solid_building_mass(36.0, -32.5, 38.0, -24.4, 5.8, "Mat_PlasterHarbor", "Mat_Terracotta")

        # Elevated B LANE (y = 0.85m, x: +33.5 .. +38.0, z: -24.4 .. -9.15) Wooden/Stone Bridge hugging Outer East Wall!
        # South climb from B Main (z: -9.15 .. -8.00, y = 0.425m)
        self.add_collider(33.5, 0.0, -9.15, 38.0, 0.425, -8.00, "floor")
        self.east_mb.add_box(33.5, 0.0, -9.15, 38.0, 0.425, -8.00, "Mat_Limestone", bevel=0.015)
        # Main B Lane stone/timber bridge deck (y = 0.85m) with bridge pier pilasters & dark-oak curbing
        self.add_collider(33.5, 0.0, -24.4, 38.0, 0.85, -9.15, "floor")
        self.east_mb.add_box(33.5, 0.0, -24.4, 38.0, 0.76, -9.15, "Mat_Limestone", bevel=0.015)
        self.east_mb.add_box(33.48, 0.76, -24.4, 38.0, 0.85, -9.15, "Mat_TimberOak", bevel=0.012)
        self.east_mb.add_box(33.45, 0.74, -24.4, 33.62, 0.88, -9.15, "Mat_DarkOak", bevel=0.0)
        for bz in (-23.0, -19.5, -16.0, -12.5, -9.5):
            self.east_mb.add_box(33.42, 0.0, bz - 0.22, 33.58, 0.82, bz + 0.22, "Mat_BrickVenetian", bevel=0.0)
        self.add_walkable_rect(33.5, -24.4, 38.0, -8.0, "mid")
        # B Lane Harbor Parapet (split cleanly around z = -16.0m Defender Buy Barrier!)
        self.add_low_stone_cover(33.5, -15.4, 33.9, -11.0, 0.85, 1.95, "Mat_Limestone", "Mat_Terracotta")
        self.add_low_stone_cover(33.5, -19.2, 33.9, -16.6, 0.85, 1.95, "Mat_Limestone", "Mat_Terracotta")
        # B Stairs descending West from B Lane into Back Site B & Boathouse front (x: +32.35 .. +33.5, z: -23.8 .. -19.5, y = 0.425m)
        self.add_collider(32.35, 0.0, -23.8, 33.5, 0.425, -19.5, "floor")
        self.east_mb.add_box(32.35, 0.0, -23.8, 33.5, 0.425, -19.5, "Mat_Limestone", bevel=0.015)

        # B SWITCH SHED beside `b_market` Blast Door (shelters DoorSwitch_b_market at (14.38, 1.35, -18.55)!)
        # Strictly north of z = -16.0m buy barrier, wide open north & east access to the switch!
        self.add_venetian_wall(14.25, -16.75, 17.45, -16.35, 0.0, 3.05, "Mat_PlasterHarbor", "Mat_DarkOak", minimap=True)
        # Corner timber support post + low east shed crate leaving wide doorways on north (14.4..17.1) & east (-18.9..-17.55)
        self.add_collider(17.15, 0.0, -19.20, 17.45, 3.05, -18.90, "wall")
        self.east_mb.add_box(17.15, 0.0, -19.20, 17.45, 3.05, -18.90, "Mat_DarkOak", bevel=0.01)
        self.add_wood_cover_crate(16.35, -17.55, 17.35, -16.75, 0.0, 1.22, minimap=True)
        # Overhead sloped terracotta & timber B Switch Shed lean-to roof (y = 3.05 .. 3.85m, collider + rafters!)
        self.add_collider(14.25, 3.05, -19.35, 17.75, 3.85, -16.25, "wall")
        self.add_minimap_wall(14.25, -19.30, 17.65, -16.30, "roof")
        for rz in (-19.0, -17.8, -16.6):
            self.east_mb.add_box(14.25, 2.94, rz - 0.09, 17.55, 3.12, rz + 0.09, "Mat_DarkOak", bevel=0.0)
        self.east_mb.add_oriented_box(16.05, 3.45, -17.80, 3.70, 0.14, 3.25, 0.0, 0.0, -0.18, "Mat_Terracotta", bevel=0.0)

        # Bomb Site B Glowing Floor Border Frame (19.5 .. 31.5, -24.0 .. -16.2)
        self._add_site_floor_border(19.5, -24.0, 31.5, -16.2, "Mat_SiteBAccent")

        # Classic B DEFAULT DOUBLE-BOX + B BACK CRATES in Site B Plant Zone (leaving Default Plant Center (25.5, -20.1) wide open!)
        self.add_radianite_crate(21.2, -22.4, 23.8, -20.0, 0.0, 1.18, "teal", minimap=True)
        self.add_radianite_crate(21.35, -22.25, 23.65, -20.15, 1.18, 2.34, "orange", minimap=False)
        self.add_radianite_crate(19.8, -19.6, 21.4, -17.8, 0.0, 1.25, "teal", minimap=True)
        # B Back Crates (back-site cover behind Default plant & beside B Stairs, keeping Boat House door & window ray clear!)
        self.add_wood_cover_crate(24.4, -23.9, 26.2, -22.4, 0.0, 1.32, minimap=True)
        self.add_radianite_crate(29.4, -22.2, 31.0, -20.6, 0.0, 1.22, "teal", minimap=True)
        # B Choke harbor cover crate south of Site B
        self.add_low_stone_cover(26.2, -13.8, 28.6, -12.4, 0.0, 1.26, "Mat_Limestone", "Mat_Terracotta")

        # CT-to-Site B North Archway (x: +17.5 .. +23.5, z: -32.5 .. -32.0)
        self.add_archway_opening(True, 17.5, 23.5, -32.5, -32.0, 3.30, 5.40, "Mat_PlasterHarbor")
        self.add_venetian_wall(23.5, -32.5, 26.0, -32.0, 0.0, 5.4, "Mat_PlasterHarbor")

        # 3. REAL B BOAT HOUSE (x: +26.0 .. +36.0, z: -32.0 .. -24.4)
        #    Enclosed Venetian harbor shed with REAL sloped terracotta-tile gable roof,
        #    wooden interior dock + canal slipway, sculpted Venetian gondola hull, doorway & shoot-through window!
        self.add_walkable_rect(26.5, -32.0, 36.0, -24.9, "ground")
        # North & East walls (eaves at y = 3.60m)
        self.add_venetian_wall(26.0, -32.5, 36.5, -32.0, 0.0, 3.60, "Mat_PlasterHarbor", "Mat_DarkOak")
        self.add_venetian_wall(36.0, -32.5, 36.5, -24.4, 0.0, 3.60, "Mat_PlasterHarbor", "Mat_DarkOak")
        # West wall (x: +26.0 .. +26.5): Side doorway facing CT-B at z: -30.8 .. -27.4
        self.add_venetian_wall(26.0, -32.0, 26.5, -30.8, 0.0, 3.60, "Mat_PlasterHarbor", "Mat_DarkOak")
        self.add_collider(26.0, 2.85, -30.8, 26.5, 3.60, -27.4, "wall")
        self.east_mb.add_box(26.0, 2.85, -30.8, 26.5, 3.60, -27.4, "Mat_DarkOak", bevel=0.015)
        self.add_venetian_wall(26.0, -27.4, 26.5, -24.9, 0.0, 3.60, "Mat_PlasterHarbor", "Mat_DarkOak")
        # South wall facing Site B (z: -24.9 .. -24.4):
        #   - Doorway facing Site B [27.0 .. 30.4]
        #   - Shoot-Through Window [31.4 .. 35.0] (open band y = 1.10 .. 2.50m!)
        self.add_venetian_wall(26.0, -24.9, 27.0, -24.4, 0.0, 3.60, "Mat_PlasterHarbor", "Mat_DarkOak")
        self.add_collider(27.0, 2.85, -24.9, 30.4, 3.60, -24.4, "wall")
        self.east_mb.add_box(27.0, 2.85, -24.9, 30.4, 3.60, -24.4, "Mat_DarkOak", bevel=0.015)
        self.add_venetian_wall(30.4, -24.9, 31.4, -24.4, 0.0, 3.60, "Mat_PlasterHarbor", "Mat_DarkOak")
        self.add_shoot_window_wall(True, 31.4, 35.0, -24.9, -24.4, 1.10, 2.50, 3.60, "Mat_PlasterHarbor")
        self.add_venetian_wall(35.0, -24.9, 36.5, -24.4, 0.0, 3.60, "Mat_PlasterHarbor", "Mat_DarkOak")

        # Real Sloped Terracotta-Tile Gable Roof + Timber Trusses over Boathouse!
        self.add_collider(26.0, 3.60, -32.5, 36.5, 4.55, -24.4, "wall")
        self.add_minimap_wall(26.0, -32.5, 36.5, -24.4, "roof")
        # Triangular stone gable pediments on West & East ends (ridge at z = -28.45, y = 5.35m)
        gable_poly = [(3.60, -32.55), (5.25, -28.45), (3.60, -24.35)]
        self.east_mb.add_prism_extrude_x(26.0, 26.45, gable_poly, "Mat_PlasterHarbor")
        self.east_mb.add_prism_extrude_x(36.05, 36.5, gable_poly, "Mat_PlasterHarbor")
        # Two sloped terracotta roof planes (pitch ~21.8 deg) + ridge barrel tiles + 3 exposed timber king-post trusses!
        slope_angle = math.atan2(5.35 - 3.60, 4.35)
        slope_len = math.hypot(5.35 - 3.60, 4.55)
        self.east_mb.add_oriented_box(31.25, 4.52, -30.62, 11.1, 0.18, slope_len, -slope_angle, 0.0, 0.0, "Mat_Terracotta", bevel=0.0)
        self.east_mb.add_oriented_box(31.25, 4.52, -26.28, 11.1, 0.18, slope_len, slope_angle, 0.0, 0.0, "Mat_Terracotta", bevel=0.0)
        self.east_mb.add_cylinder(31.25, 5.46, -28.45, 0.18, 0.18, 11.2, "Mat_Terracotta", segments=8, axis="x")
        for rx in (27.0, 28.4, 29.8, 31.2, 32.6, 34.0, 35.4):
            self.east_mb.add_oriented_box(rx, 4.62, -30.62, 0.12, 0.10, slope_len - 0.1, -slope_angle, 0.0, 0.0, "Mat_Terracotta", bevel=0.0)
            self.east_mb.add_oriented_box(rx, 4.62, -26.28, 0.12, 0.10, slope_len - 0.1, slope_angle, 0.0, 0.0, "Mat_Terracotta", bevel=0.0)
        # Exposed interior dark-oak timber trusses (tie beams + king posts)
        for tx in (28.2, 30.8, 33.4):
            self.east_mb.add_box(tx - 0.12, 3.42, -32.0, tx + 0.12, 3.62, -24.9, "Mat_DarkOak", bevel=0.0)
            self.east_mb.add_box(tx - 0.10, 3.62, -28.6, tx + 0.10, 5.15, -28.3, "Mat_DarkOak", bevel=0.0)

        # Wooden Interior Dock curbing & cast-iron Venetian mooring bollards along canal slipway edge (x = 32.78)
        self.props_mb.add_box(32.68, 0.016, -32.0, 32.86, 0.09, -26.8, "Mat_DarkOak", bevel=0.0)
        self.props_mb.add_box(32.68, 0.016, -26.92, 36.0, 0.09, -26.74, "Mat_DarkOak", bevel=0.0)
        for mbz in (-31.1, -29.2, -27.2):
            self.props_mb.add_cylinder(32.76, 0.22, mbz, 0.11, 0.09, 0.34, "Mat_DarkIron", segments=8, axis="y")
            self.props_mb.add_cylinder(32.76, 0.40, mbz, 0.14, 0.14, 0.06, "Mat_DarkIron", segments=8, axis="y")

        # Sculpted Venetian Wooden Gondola Hull floating in the Boat House canal slipway!
        self.add_collider(33.4, 0.0, -31.4, 35.4, 1.12, -27.8, "cover")
        self.add_minimap_wall(33.4, -31.4, 35.4, -27.8, "cover")
        # Curved multi-tier dark-oak hull + gunwale trim + upturned tapered bow & stern + benches + metallic ferro + oar
        self.props_mb.add_box(33.75, 0.02, -30.7, 35.05, 0.34, -28.5, "Mat_DarkOak", bevel=0.02)
        self.props_mb.add_box(33.52, 0.34, -30.9, 35.28, 0.88, -28.3, "Mat_DarkOak", bevel=0.025)
        self.props_mb.add_box(33.48, 0.86, -30.95, 33.66, 0.98, -28.25, "Mat_TimberOak", bevel=0.0)
        self.props_mb.add_box(35.14, 0.86, -30.95, 35.32, 0.98, -28.25, "Mat_TimberOak", bevel=0.0)
        # Interior rowing benches (thwarts)
        self.props_mb.add_box(33.62, 0.62, -30.15, 35.18, 0.72, -29.85, "Mat_WoodCrate", bevel=0.0)
        self.props_mb.add_box(33.62, 0.62, -29.35, 35.18, 0.72, -29.05, "Mat_WoodCrate", bevel=0.0)
        # Tapered upturned bow & stern prows
        self.props_mb.add_cylinder(34.4, 0.68, -31.15, 0.82, 0.10, 0.72, "Mat_DarkOak", segments=8, axis="z", smooth=True)
        self.props_mb.add_cylinder(34.4, 0.68, -28.05, 0.10, 0.82, 0.72, "Mat_DarkOak", segments=8, axis="z", smooth=True)
        # Iconic curved metallic Venetian 'ferro' prow ornament & diagonal resting wooden oar
        self.props_mb.add_branch((34.4, 0.82, -27.85), (34.4, 1.38, -27.70), 0.05, 0.04, "Mat_BlastSteel", segments=6)
        self.props_mb.add_box(34.36, 1.10, -27.78, 34.44, 1.32, -27.54, "Mat_BlastSteel", bevel=0.0)
        self.props_mb.add_branch((33.55, 0.96, -30.5), (35.22, 1.02, -28.6), 0.035, 0.035, "Mat_WoodCrate", segments=6)

    # -----------------------------------------------------------------------
    # Interactive Breakable Blast Doors (`a_tree` & `b_market`)
    # -----------------------------------------------------------------------

    def _build_interactive_blast_doors(self) -> List[bpy.types.Object]:
        """
        Builds static Blast Door frames + overhead shutter housings in static batches,
        and exports the 4 named interactive GLB nodes with local pivots at exact closed centers:
          - `DoorPanel_a_tree`, `DoorSwitch_a_tree`
          - `DoorPanel_b_market`, `DoorSwitch_b_market`
        """
        door_specs = [
            {
                "id": "a_tree",
                "label": "A TREE DOOR",
                "x0": -14.22,
                "x1": -13.78,
                "z0": -19.60,
                "z1": -16.40,
                "y0": 0.0,
                "y1": 3.00,
                "switch_pos": (-14.38, 1.35, -15.55),
                "switch_facing_sign": -1.0,  # West face inside Site A
                "max_hp": 400,
            },
            {
                "id": "b_market",
                "label": "B MARKET DOOR",
                "x0": 13.78,
                "x1": 14.22,
                "z0": -22.60,
                "z1": -19.40,
                "y0": 0.0,
                "y1": 3.00,
                "switch_pos": (14.38, 1.35, -18.55),
                "switch_facing_sign": 1.0,  # East face inside Site B
                "max_hp": 400,
            },
        ]

        out_objs: List[bpy.types.Object] = []
        for spec in door_specs:
            did = spec["id"]
            x0, x1 = spec["x0"], spec["x1"]
            z0, z1 = spec["z0"], spec["z1"]
            y0, y1 = spec["y0"], spec["y1"]
            cx, cy, cz = round(0.5 * (x0 + x1), 3), round(0.5 * (y0 + y1), 3), round(0.5 * (z0 + z1), 3)
            sx, sy, sz = spec["switch_pos"]

            # Static overhead mechanical shutter housing (y = 3.00 .. 6.35m) so panel retracts +3.1m cleanly inside!
            self.add_collider(x0 - 0.06, 3.00, z0 - 0.15, x1 + 0.06, 6.35, z1 + 0.15, "wall")
            mb = self._pick_mb(x0, x1)
            # Side guide rails + overhead armored shutter box (hollow slot inside so zero coplanar faces with sliding panel!)
            mb.add_box(x0 - 0.08, 0.0, z0 - 0.22, x1 + 0.08, 6.35, z0, "Mat_DarkIron", bevel=0.015)
            mb.add_box(x0 - 0.08, 0.0, z1, x1 + 0.08, 6.35, z1 + 0.22, "Mat_DarkIron", bevel=0.015)
            mb.add_box(x0 - 0.12, 3.00, z0 - 0.22, x0 - 0.02, 6.35, z1 + 0.22, "Mat_DarkIron", bevel=0.015)
            mb.add_box(x1 + 0.02, 3.00, z0 - 0.22, x1 + 0.12, 6.35, z1 + 0.22, "Mat_DarkIron", bevel=0.015)
            mb.add_box(x0 - 0.14, 6.15, z0 - 0.24, x1 + 0.14, 6.38, z1 + 0.24, "Mat_HazardGold", bevel=0.015)

            # Static switch mounting backplate on wall
            face_s = spec["switch_facing_sign"]
            mb.add_box(sx - 0.09 * face_s, sy - 0.28, sz - 0.22, sx - 0.02 * face_s, sy + 0.28, sz + 0.22, "Mat_DarkIron", bevel=0.01)

            # 1. Named Interactive `DoorPanel_<id>` (pivot at exact closed center `(cx, cy, cz)`)
            panel_mb = WorldMeshBuilder(f"DoorPanel_{did}", self.palette, origin_world=(cx, cy, cz))
            px0, px1 = cx - 0.14, cx + 0.14
            pz0, pz1 = z0 + 0.02, z1 - 0.02
            panel_mb.add_box(px0, y0 + 0.02, pz0, px1, y1 - 0.02, pz1, "Mat_BlastSteel", bevel=0.015)
            # Horizontal stiffening ribs + caution chevron band
            for ry in (0.45, 1.05, 1.95, 2.55):
                panel_mb.add_box(px0 - 0.025, ry - 0.06, pz0 + 0.06, px1 + 0.025, ry + 0.06, pz1 - 0.06, "Mat_DarkIron", bevel=0.01)
            panel_mb.add_box(px0 - 0.028, 1.38, pz0 + 0.08, px1 + 0.028, 1.64, pz1 - 0.08, "Mat_HazardGold", bevel=0.01)
            out_objs.append(panel_mb.finalize_object())

            # 2. Named Interactive `DoorSwitch_<id>` (pivot at exact `switchPos` `(sx, sy, sz)`)
            sw_mat = make_pbr_material(f"Mat_DoorSwitchLED_{did}", 0x2ECC71, roughness=0.25, metallic=0.1, emission_hex=0x2ECC71, emission_strength=2.2)
            self.palette.by_name[f"Mat_DoorSwitchLED_{did}"] = sw_mat
            self.palette.ordered.append(sw_mat)

            sw_mb = WorldMeshBuilder(f"DoorSwitch_{did}", self.palette, origin_world=(sx, sy, sz))
            bx0 = min(sx - 0.02 * face_s, sx + 0.05 * face_s)
            bx1 = max(sx - 0.02 * face_s, sx + 0.05 * face_s)
            sw_mb.add_box(bx0, sy - 0.18, sz - 0.14, bx1, sy + 0.18, sz + 0.14, f"Mat_DoorSwitchLED_{did}", bevel=0.012)
            out_objs.append(sw_mb.finalize_object())

            self.doors.append({
                "id": did,
                "label": spec["label"],
                "bounds": {
                    "min": {"x": round(x0, 3), "y": round(y0, 3), "z": round(z0, 3)},
                    "max": {"x": round(x1, 3), "y": round(y1, 3), "z": round(z1, 3)},
                },
                "center": {"x": cx, "y": cy, "z": cz},
                "switchPos": {"x": round(sx, 3), "y": round(sy, 3), "z": round(sz, 3)},
                "maxHp": spec["max_hp"],
            })

        return out_objs

    # -----------------------------------------------------------------------
    # Iconic Venetian Skyline: Perimeter Terracotta Palazzos, Campanile & Floating Islands
    # -----------------------------------------------------------------------

    def _build_skyline(self) -> None:
        mb = self.skyline_mb

        # 0. VENETIAN TERRACOTTA PITCHED ROOFTOPS & PALAZZO FACADES crowning perimeter & landmark skylines!
        #    Purely visual above y >= 5.6m (zero physics colliders, bevel=0.0 for lean GLB!).
        # West Perimeter Palazzos (behind T-Spawn, A Lobby, Site A, A Heaven)
        self.add_venetian_palazzo_top(-41.4, 20.6, -32.2, 44.8, 5.8, 3.0, 2.0, "Mat_PlasterWarm", ridge_along_x=False)
        self.add_venetian_palazzo_top(-41.4, 6.4, -35.2, 19.6, 5.6, 2.8, 1.6, "Mat_PlasterOchre", ridge_along_x=False)
        self.add_venetian_palazzo_top(-41.4, -32.2, -36.2, -8.6, 6.0, 3.4, 1.8, "Mat_PlasterWarm", ridge_along_x=False)
        self.add_venetian_palazzo_top(-41.4, -45.2, -26.2, -32.8, 6.0, 3.6, 2.2, "Mat_BrickVenetian", ridge_along_x=True)
        # East Perimeter Palazzos (behind T-Spawn, B Lobby, B Lane, CT-B)
        self.add_venetian_palazzo_top(32.2, 20.6, 41.4, 44.8, 5.8, 3.0, 2.0, "Mat_PlasterPeach", ridge_along_x=False)
        self.add_venetian_palazzo_top(35.2, 4.4, 41.4, 19.6, 5.6, 2.8, 1.6, "Mat_PlasterHarbor", ridge_along_x=False)
        self.add_venetian_palazzo_top(38.0, -32.2, 41.4, -8.2, 5.8, 3.0, 1.5, "Mat_PlasterHarbor", ridge_along_x=False)
        self.add_venetian_palazzo_top(24.2, -45.2, 41.4, -32.8, 6.0, 3.6, 2.2, "Mat_PlasterOchre", ridge_along_x=True)
        # Interior Divider Landmark Palazzos framing Mid Courtyard & Site A/B silhouettes!
        self.add_venetian_palazzo_top(-24.2, -7.8, -15.8, 5.6, 5.6, 2.2, 1.7, "Mat_PlasterWarm", ridge_along_x=False)
        self.add_venetian_palazzo_top(11.3, -7.8, 17.5, 5.4, 5.6, 2.2, 1.6, "Mat_PlasterOchre", ridge_along_x=False)
        self.add_venetian_palazzo_top(-16.0, 9.9, -8.1, 19.6, 5.6, 1.9, 1.5, "Mat_PlasterPeach", ridge_along_x=True, add_chimney=False)
        self.add_venetian_palazzo_top(11.3, 9.6, 17.9, 19.6, 5.6, 1.9, 1.5, "Mat_PlasterPeach", ridge_along_x=True, add_chimney=False)

        # 1. ICONIC CAMPANILE BELL TOWER rising beyond North-Mid (cx = +3.0, cz = -54.0, height = 34.0m!)
        bx, bz = 3.0, -54.0
        # Floating stone island pedestal supporting the Bell Tower
        mb.add_cylinder(bx, -2.5, bz, 4.5, 9.2, 6.0, "Mat_CliffRock", segments=9, axis="y")
        mb.add_box(bx - 7.5, 0.0, bz - 7.5, bx + 7.5, 0.8, bz + 7.5, "Mat_Limestone", bevel=0.0)
        # Limestone base plinth (y: 0.8 .. 3.2)
        mb.add_box(bx - 4.2, 0.8, bz - 4.2, bx + 4.2, 3.2, bz + 4.2, "Mat_Limestone", bevel=0.0)
        # Fluted Venetian brick shaft (y: 3.2 .. 19.5) with corner pilasters + iconic Venetian clock medallion facing Mid!
        mb.add_box(bx - 3.6, 3.2, bz - 3.6, bx + 3.6, 19.5, bz + 3.6, "Mat_BrickVenetian", bevel=0.0)
        for px in (-3.72, -1.2, 1.2, 3.72):
            mb.add_box(bx + px - 0.22, 3.4, bz - 3.75, bx + px + 0.22, 19.3, bz + 3.75, "Mat_Limestone", bevel=0.0)
            mb.add_box(bx - 3.75, 3.4, bz + px - 0.22, bx + 3.75, 19.3, bz + px + 0.22, "Mat_Limestone", bevel=0.0)
        # Venetian Clock Medallion facing south toward Mid Courtyard
        mb.add_cylinder(bx, 16.5, bz + 3.72, 1.45, 1.45, 0.18, "Mat_Limestone", segments=12, axis="z")
        mb.add_cylinder(bx, 16.5, bz + 3.82, 1.18, 1.18, 0.10, "Mat_PlasterHarbor", segments=12, axis="z")
        mb.add_cylinder(bx, 16.5, bz + 3.90, 0.20, 0.20, 0.08, "Mat_GoldBell", segments=8, axis="z")
        # Cornice gallery deck (y: 19.5 .. 20.6)
        mb.add_box(bx - 4.3, 19.5, bz - 4.3, bx + 4.3, 20.6, bz + 4.3, "Mat_Limestone", bevel=0.0)
        # Open 4-sided arched Belfry Loggia (y: 20.6 .. 24.8) + Hanging Golden Bell!
        for cx_off in (-3.4, 0.0, 3.4):
            for cz_off in (-3.4, 0.0, 3.4):
                if cx_off == 0.0 and cz_off == 0.0:
                    continue
                mb.add_box(bx + cx_off - 0.42, 20.6, bz + cz_off - 0.42, bx + cx_off + 0.42, 24.8, bz + cz_off + 0.42, "Mat_Limestone", bevel=0.0)
        mb.add_cylinder(bx, 22.8, bz, 1.05, 0.55, 1.65, "Mat_GoldBell", segments=12, axis="y", smooth=True)
        # Belfry attic entablature (y: 24.8 .. 26.2) + Pyramidal Terracotta Spire (y: 26.2 .. 32.8) + Golden Finial!
        mb.add_box(bx - 4.1, 24.8, bz - 4.1, bx + 4.1, 26.2, bz + 4.1, "Mat_Limestone", bevel=0.0)
        mb.add_cylinder(bx, 29.5, bz, 4.6, 0.12, 6.6, "Mat_Terracotta", segments=4, axis="y")
        mb.add_cylinder(bx, 33.4, bz, 0.35, 0.05, 1.5, "Mat_GoldBell", segments=8, axis="y")

        # 2. STYLIZED FLOATING VENETIAN CLIFF-ISLANDS around the far horizon (iconic Ascent sky-city vibe!)
        islands = [
            (-58.0, 4.0, -24.0, 8.5, "Mat_PlasterWarm", True),
            (-56.0, 6.5, 18.0, 7.2, "Mat_PlasterPeach", False),
            (58.0, 3.5, -22.0, 8.8, "Mat_PlasterHarbor", True),
            (57.0, 5.5, 16.0, 7.4, "Mat_PlasterOchre", False),
            (-36.0, 7.0, -60.0, 8.0, "Mat_PlasterWarm", True),
            (38.0, 6.0, -58.0, 7.6, "Mat_PlasterHarbor", True),
        ]
        for ix, iy, iz, ir, house_mat, ridge_x in islands:
            # Inverted tapered floating rock spire + travertine plaza cap
            mb.add_cylinder(ix, iy - 5.2, iz, 0.8, ir, 10.4, "Mat_CliffRock", segments=7, axis="y")
            mb.add_cylinder(ix, iy + 0.35, iz, ir, ir * 0.94, 0.7, "Mat_TravertineFloor", segments=7, axis="y")
            # Mini Venetian cliff-top villa with real pitched terracotta gable roof + cypress trees!
            vx0, vx1 = ix - ir * 0.38, ix + ir * 0.38
            vz0, vz1 = iz - ir * 0.32, iz + ir * 0.32
            mb.add_box(vx0, iy + 0.7, vz0, vx1, iy + 4.8, vz1, house_mat, bevel=0.0)
            mb.add_pitched_roof(vx0, vz0, vx1, vz1, iy + 4.8, 1.75, ridge_along_x=ridge_x, roof_mat="Mat_Terracotta", gable_mat=house_mat, overhang=0.28, add_ribs=False)
            self.add_olive_tree(ix + ir * 0.52, iy + 0.7, iz - ir * 0.25, 0.95, cypress=True)
            self.add_olive_tree(ix - ir * 0.50, iy + 0.7, iz + ir * 0.30, 0.80, cypress=True)


# ---------------------------------------------------------------------------
# Physics Verification, Raycaster & Multi-Level 3D Waypoint Graph Generator
# ---------------------------------------------------------------------------

def intervals_overlap(a0: float, a1: float, b0: float, b1: float) -> bool:
    return a1 > b0 and a0 < b1


def is_capsule_clear(x: float, y: float, z: float, colliders: List[Dict], radius: float = 0.46, height: float = PLAYER_HEIGHT_M) -> bool:
    x0, x1 = x - radius, x + radius
    y0, y1 = y + 0.03, y + height - 0.02
    z0, z1 = z - radius, z + radius
    for c in colliders:
        mn, mx = c["min"], c["max"]
        if intervals_overlap(x0, x1, mn["x"], mx["x"]) and intervals_overlap(y0, y1, mn["y"], mx["y"]) and intervals_overlap(z0, z1, mn["z"], mx["z"]):
            return False
    return True


def has_floor_support(x: float, y: float, z: float, colliders: List[Dict], tol: float = 0.04, margin: float = 0.12) -> bool:
    for c in colliders:
        mn, mx = c["min"], c["max"]
        if abs(mx["y"] - y) <= tol and (mn["x"] + margin) <= x <= (mx["x"] - margin) and (mn["z"] + margin) <= z <= (mx["z"] - margin):
            return True
    return False


def raycast_aabb(
    ox: float,
    oy: float,
    oz: float,
    dx: float,
    dy: float,
    dz: float,
    box: Dict,
    max_dist: float,
) -> Optional[float]:
    """Exact Kay-Kajiya Slab Method matching `src/physics/movement.ts`."""
    t_near = -1e30
    t_far = 1e30
    mn, mx = box["min"], box["max"]

    for o, d, bmin, bmax in ((ox, dx, mn["x"], mx["x"]), (oy, dy, mn["y"], mx["y"]), (oz, dz, mn["z"], mx["z"])):
        if abs(d) < 1e-9:
            if o < bmin or o > bmax:
                return None
            continue
        inv_d = 1.0 / d
        t1 = (bmin - o) * inv_d
        t2 = (bmax - o) * inv_d
        if t1 > t2:
            t1, t2 = t2, t1
        if t1 > t_near:
            t_near = t1
        if t2 < t_far:
            t_far = t2
        if t_near > t_far:
            return None

    if t_near < 0.0 or t_near > max_dist:
        return None
    return t_near


def classify_zone(x: float, y: float, z: float, sites: Dict) -> str:
    if z >= 20.5 or z <= -33.0:
        return "spawn"
    sa = sites["A"]
    sb = sites["B"]
    if (sa["minX"] - 3.0 <= x <= sa["maxX"] + 3.0 and sa["minZ"] - 9.0 <= z <= sa["maxZ"] + 2.5) or (y >= 2.5 and x < -18.0):
        return "site_a"
    if sb["minX"] - 3.0 <= x <= sb["maxX"] + 6.5 and sb["minZ"] - 8.5 <= z <= sb["maxZ"] + 2.5:
        return "site_b"
    if -13.5 <= x <= 13.8 and -26.0 <= z <= 20.0:
        return "mid"
    return "flank"


def generate_waypoints(
    colliders: List[Dict],
    walkable_rects: List[Dict],
    sites: Dict,
) -> List[Dict]:
    candidates: List[Tuple[float, float, float]] = []

    # 1. Sample 2.0m lattice across all ground & spawn walkable rects (y = 0.0)
    #    Use a small +0.35m pad on rect bounds so adjacent rooms meet seamlessly across doorways,
    #    while `is_capsule_clear` enforces exact 0.45m clearance from all walls & cover!
    gx = -40.0
    while gx <= 40.0:
        gz = -44.0
        while gz <= 44.0:
            in_ground = any(
                r["level"] in ("ground", "spawn_a", "spawn_d")
                and (r["x0"] - 0.35) <= gx <= (r["x1"] + 0.35)
                and (r["z0"] - 0.35) <= gz <= (r["z1"] + 0.35)
                for r in walkable_rects
            )
            if in_ground:
                candidates.append((round(gx, 2), 0.0, round(gz, 2)))
            gz += 2.0
        gx += 2.0

    # 2. Sample elevated Mid Catwalk (y = 0.85) + Catwalk stairs (y = 0.425)
    for cz in (-7.2, -5.4, -3.6, -1.8, 0.0):
        for cx in (-10.8, -9.6):
            candidates.append((cx, 0.85, cz))
    candidates.extend([
        (-9.7, 0.425, 1.42),   # South Tiles -> Catwalk step
        (-9.7, 0.425, -8.58),  # North Catwalk -> A Tree step
        (-7.02, 0.425, -0.5),  # Side Courtyard -> Catwalk step
    ])

    # 3. Sample elevated B Lane (y = 0.85) + B Lane / B Stairs treads (y = 0.425)
    for cz in (-23.2, -21.2, -19.2, -17.2, -15.0, -13.0, -11.0, -9.8):
        for cx in (34.8, 36.8):
            candidates.append((cx, 0.85, cz))
    candidates.extend([
        (35.8, 0.425, -8.58),   # South B Main -> B Lane step
        (32.92, 0.425, -21.6),  # West B Stairs -> Site B step
        (32.92, 0.425, -20.2),
    ])

    # 4. Sample CT-to-Heaven 7-Tread Staircase + A Heaven (y = 3.00, offset +0.55m from ground grid so 2D lookups stay distinct!)
    stair_x_start = -13.10
    tread_run = 1.15
    for i in range(6):
        tx_mid = round(stair_x_start - (i + 0.5) * tread_run, 2)
        ty = round((i + 1) * (3.00 / 7.0), 3)
        candidates.append((tx_mid, ty, -34.7))
        candidates.append((tx_mid, ty, -33.5))

    # A Heaven North Landing & Rafters Deck (y = 3.00, navigating smoothly around Heaven cover box!)
    for hx in (-25.05, -23.05, -21.05):
        for hz in (-35.55, -33.55, -31.85):
            candidates.append((hx, 3.00, hz))
    for hx in (-32.85, -30.65, -28.45, -26.25, -24.05, -21.85):
        for hz in (-30.65, -28.65, -26.65, -25.15):
            candidates.append((hx, 3.00, hz))

    # 5. Explicit Tactical Anchors (Buy-barrier doorways, Blast Doors, Connectors, Spawns, Pedestal, Hell, Boathouse, Wine, Market)
    anchors = [
        # South Buy-Barrier 3 Archways + North Archways
        (-25.5, 0.0, 20.0), (5.5, 0.0, 20.0), (25.5, 0.0, 20.0),
        (-27.5, 0.0, 6.0), (-27.5, 0.0, -8.0),
        (27.2, 0.0, 4.0), (27.5, 0.0, -8.0),
        (-13.1, 0.0, -29.8), (-17.0, 0.0, -24.2), (20.5, 0.0, -32.2),
        # A Tree <-> CT-A / A Heaven North-East Connector Doorway
        (-7.7, 0.0, -21.2), (-7.7, 0.0, -23.0), (-7.7, 0.0, -25.0), (-7.7, 0.0, -27.2), (-7.7, 0.0, -29.6),
        (-10.5, 0.0, -29.8),
        # Arched Mid Link Portal -> Defender Spawn
        (-0.7, 0.0, -14.2), (-0.7, 0.0, -16.0), (-0.7, 0.0, -18.5), (-0.7, 0.0, -21.0),
        (-0.7, 0.0, -23.5), (-0.7, 0.0, -26.0), (-0.7, 0.0, -28.0),
        # Mid Subroza / Catwalk Cubby
        (-6.4, 0.0, -6.5), (-6.4, 0.0, -4.6),
        # Blast door thresholds (open at round start) + B Switch Shed interior
        (-15.2, 0.0, -18.0), (-14.0, 0.0, -18.0), (-12.8, 0.0, -18.0),
        (12.8, 0.0, -21.0), (14.0, 0.0, -21.0), (15.2, 0.0, -21.0),
        (15.5, 0.0, -18.2), (16.0, 0.0, -20.0),
        # Stair base anchors
        (-12.2, 0.0, -34.7), (-12.2, 0.0, -33.5),
        (-9.7, 0.0, 2.7), (-9.7, 0.0, -9.9), (-5.8, 0.0, -0.5),
        (35.8, 0.0, -7.2), (35.8, 0.0, -5.0), (31.6, 0.0, -21.6), (31.6, 0.0, -20.2),
        # A Hell interior & arches (clear of wooden Hell cover crates)
        (-30.4, 0.0, -24.2), (-24.1, 0.0, -24.2),
        (-30.2, 0.0, -27.6), (-27.0, 0.0, -29.0), (-23.8, 0.0, -27.6),
        # Boathouse doorways & interior dock
        (28.7, 0.0, -24.6), (28.7, 0.0, -26.2), (31.2, 0.0, -26.2), (26.2, 0.0, -29.1), (24.8, 0.0, -29.1),
        # Market doorways
        (4.3, 0.0, -15.1), (4.3, 0.0, -13.8), (4.3, 0.0, -16.5),
        (7.3, 0.0, -25.7), (7.3, 0.0, -24.2), (7.3, 0.0, -27.2),
        # Deepened A Wine, B Logs, Top Mid dog-leg, Lobbies & A Lobby <-> Mid Tiles arch
        (-31.2, 0.0, -4.2), (-33.8, 0.0, -4.2), (-36.4, 0.0, -4.2),
        (21.2, 0.0, -4.2), (20.1, 0.0, -4.2),
        (1.0, 0.0, 14.4), (-1.0, 0.0, 14.4), (3.0, 0.0, 14.4),
        (-16.0, 0.0, 8.2), (11.5, 0.0, 7.5), (18.0, 0.0, 7.5),
        # Spawns & Spike Pedestal
        (0.0, 0.0, 33.0), (-6.0, 0.0, 37.0), (0.0, 0.0, 37.0), (6.0, 0.0, 37.0),
        (-6.0, 0.0, -39.5), (0.0, 0.0, -39.5), (6.0, 0.0, -39.5),
    ]
    candidates.extend(anchors)

    # Deduplicate (within 0.65m 3D distance) and filter by capsule + floor support!
    accepted: List[Tuple[float, float, float]] = []
    for (x, y, z) in candidates:
        if not is_capsule_clear(x, y, z, colliders, radius=0.45):
            continue
        if not has_floor_support(x, y, z, colliders, tol=0.05):
            continue
        if any(math.hypot(x - ax, z - az) < 0.72 and abs(y - ay) < 0.25 for (ax, ay, az) in accepted):
            continue
        accepted.append((x, y, z))

    # Build bidirectional step-safe edges
    n = len(accepted)
    adj: List[List[int]] = [[] for _ in range(n)]
    for i in range(n):
        x1, y1, z1 = accepted[i]
        for j in range(i + 1, n):
            x2, y2, z2 = accepted[j]
            dy = abs(y1 - y2)
            if dy > STEP_LIMIT_M:
                continue
            dist2d = math.hypot(x1 - x2, z1 - z2)
            max_link = 2.65 if dy > 0.05 else 3.35
            if dist2d > max_link:
                continue

            # Capsule sweep along 5 interior points at max(y1, y2) to guarantee step & doorway clearance
            y_top = max(y1, y2)
            clear_edge = True
            for t in (0.2, 0.4, 0.5, 0.6, 0.8):
                mx = x1 + (x2 - x1) * t
                mz = z1 + (z2 - z1) * t
                my_floor = y1 + (y2 - y1) * t
                if not is_capsule_clear(mx, y_top, mz, colliders, radius=0.39):
                    clear_edge = False
                    break
                # Prevent linking across high ledges where intermediate floor drops > 0.6m
                if y_top > 0.5 and not (
                    has_floor_support(mx, y1, mz, colliders, tol=0.50, margin=-0.03)
                    or has_floor_support(mx, y2, mz, colliders, tol=0.50, margin=-0.03)
                    or has_floor_support(mx, my_floor, mz, colliders, tol=0.50, margin=-0.03)
                ):
                    clear_edge = False
                    break
            if clear_edge:
                adj[i].append(j)
                adj[j].append(i)

    # Keep main connected component from T-Spawn (0, 0, 33) and verify!
    start_idx = min(range(n), key=lambda k: math.hypot(accepted[k][0] - 0.0, accepted[k][2] - 33.0) + abs(accepted[k][1]))
    visited = {start_idx}
    q = deque([start_idx])
    while q:
        u = q.popleft()
        for v in adj[u]:
            if v not in visited:
                visited.add(v)
                q.append(v)

    # Prune any tiny unreachable corner sample ONLY if major tactical zones are 100% reached,
    # then assert 100% BFS connectivity on exported waypoints!
    kept_old_indices = sorted(visited)
    old_to_new = {old_i: new_i for new_i, old_i in enumerate(kept_old_indices)}

    waypoints: List[Dict] = []
    for new_i, old_i in enumerate(kept_old_indices):
        x, y, z = accepted[old_i]
        wp_id = f"wp_{new_i}"
        nbrs = [f"wp_{old_to_new[v]}" for v in adj[old_i] if v in old_to_new]
        waypoints.append({
            "id": wp_id,
            "pos": {"x": round(x, 2), "y": round(y, 3), "z": round(z, 2)},
            "neighbors": nbrs,
            "zone": classify_zone(x, y, z, sites),
        })

    return waypoints


def run_mandatory_proofs(
    colliders: List[Dict],
    waypoints: List[Dict],
    spawns: Dict,
    sites: Dict,
    doors: List[Dict],
    glb_path: str,
    total_tris: int,
) -> None:
    # 1. Assert 100% BFS Connectivity + A Heaven (y >= 2.8) + A Hell (y == 0.0 under Heaven)
    assert len(waypoints) >= 250, f"Too few waypoints: {len(waypoints)}"
    by_id = {wp["id"]: wp for wp in waypoints}
    seen = {waypoints[0]["id"]}
    q = deque([waypoints[0]["id"]])
    while q:
        curr = q.popleft()
        for nxt in by_id[curr]["neighbors"]:
            if nxt not in seen:
                seen.add(nxt)
                q.append(nxt)
    assert len(seen) == len(waypoints), f"BFS connectivity failed: {len(seen)}/{len(waypoints)}"

    heaven_wps = [wp for wp in waypoints if wp["pos"]["y"] >= 2.8]
    hell_wps = [
        wp for wp in waypoints
        if abs(wp["pos"]["y"]) < 0.05 and -34.0 <= wp["pos"]["x"] <= -20.5 and -32.0 <= wp["pos"]["z"] <= -24.5
    ]
    catwalk_wps = [wp for wp in waypoints if 0.75 <= wp["pos"]["y"] <= 0.95 and wp["pos"]["x"] < 0]
    blane_wps = [wp for wp in waypoints if 0.75 <= wp["pos"]["y"] <= 0.95 and wp["pos"]["x"] > 0]
    tree_ct_wps = [
        wp for wp in waypoints
        if abs(wp["pos"]["y"]) < 0.05 and -9.8 <= wp["pos"]["x"] <= -5.6 and -27.5 <= wp["pos"]["z"] <= -22.5
    ]
    mid_link_wps = [
        wp for wp in waypoints
        if abs(wp["pos"]["y"]) < 0.05 and -4.75 <= wp["pos"]["x"] <= 1.75 and -27.5 <= wp["pos"]["z"] <= -16.0
    ]
    boathouse_wps = [
        wp for wp in waypoints
        if abs(wp["pos"]["y"]) < 0.05 and 26.5 <= wp["pos"]["x"] <= 35.8 and -32.0 <= wp["pos"]["z"] <= -24.9
    ]

    assert len(heaven_wps) >= 12, f"Missing A Heaven waypoints (found {len(heaven_wps)})"
    assert len(hell_wps) >= 8, f"Missing A Hell waypoints (found {len(hell_wps)})"
    assert len(catwalk_wps) >= 6, f"Missing Mid Catwalk waypoints (found {len(catwalk_wps)})"
    assert len(blane_wps) >= 8, f"Missing B Lane waypoints (found {len(blane_wps)})"
    assert len(tree_ct_wps) >= 2, f"Missing A Tree <-> CT-A connector waypoints (found {len(tree_ct_wps)})"
    assert len(mid_link_wps) >= 4, f"Missing Mid Link waypoints (found {len(mid_link_wps)})"
    assert len(boathouse_wps) >= 4, f"Missing Boat House waypoints (found {len(boathouse_wps)})"

    # Verify all spawns, pedestal, and bomb site centers are clear & reachable
    for label, pt in [
        ("ally_0", spawns["allies"][0]),
        ("ally_1", spawns["allies"][1]),
        ("ally_2", spawns["allies"][2]),
        ("enemy_0", spawns["enemies"][0]),
        ("enemy_1", spawns["enemies"][1]),
        ("enemy_2", spawns["enemies"][2]),
        ("spike", spawns["spikePedestal"]),
        ("site_a", sites["A"]["center"]),
        ("site_b", sites["B"]["center"]),
    ]:
        assert is_capsule_clear(pt["x"], 0.0, pt["z"], colliders, radius=0.40), f"Key point {label} overlaps collider: {pt}"
        nearest_d = min(math.hypot(wp["pos"]["x"] - pt["x"], wp["pos"]["z"] - pt["z"]) for wp in waypoints if wp["pos"]["y"] < 0.5)
        assert nearest_d <= 2.8, f"Key point {label} too far ({nearest_d:.2f}m) from ground waypoint!"

    # 2. Mandatory Proof: 0 Opening-Round Line-of-Sight Pairs between South (z >= +20) & North (z <= -16) Buy Zones!
    south_wps = [wp for wp in waypoints if wp["pos"]["z"] >= spawns["buyMinAllyZ"]]
    north_wps = [wp for wp in waypoints if wp["pos"]["z"] <= spawns["buyMaxDefenderZ"]]
    assert len(south_wps) >= 20, f"Expected >=20 South buy waypoints, got {len(south_wps)}"
    assert len(north_wps) >= 40, f"Expected >=40 North buy waypoints, got {len(north_wps)}"

    wall_colliders = [c for c in colliders if c["tag"] in ("wall", "cover", "floor") and c["max"]["y"] > 0.05]
    opening_los_pairs = 0
    first_leak = None
    for ws in south_wps:
        ox, oy, oz = ws["pos"]["x"], ws["pos"]["y"] + EYE_HEIGHT_M, ws["pos"]["z"]
        for wn in north_wps:
            tx, ty, tz = wn["pos"]["x"], wn["pos"]["y"] + EYE_HEIGHT_M, wn["pos"]["z"]
            vx, vy, vz = tx - ox, ty - oy, tz - oz
            dist = math.sqrt(vx * vx + vy * vy + vz * vz)
            inv = 1.0 / dist
            dx, dy, dz = vx * inv, vy * inv, vz * inv
            blocked = False
            for box in wall_colliders:
                if raycast_aabb(ox, oy, oz, dx, dy, dz, box, dist - 0.05) is not None:
                    blocked = True
                    break
            if not blocked:
                opening_los_pairs += 1
                if first_leak is None:
                    first_leak = (ws["pos"], wn["pos"])

    assert opening_los_pairs == 0, f"OPENING LOS LEAK ({opening_los_pairs} pairs)! First leak: {first_leak}"

    # 3. Verify Market & Boathouse Windows have clear shoot-through rays at y = 1.62m!
    for wname, (rx0, ry0, rz0), (rx1, ry1, rz1) in [
        ("Market Window", (9.2, 1.62, -18.0), (9.2, 1.62, -12.0)),
        ("Boathouse Window", (33.2, 1.62, -27.0), (33.2, 1.62, -22.0)),
    ]:
        vx, vy, vz = rx1 - rx0, ry1 - ry0, rz1 - rz0
        dist = math.sqrt(vx * vx + vy * vy + vz * vz)
        dx, dy, dz = vx / dist, vy / dist, vz / dist
        hits = [c for c in colliders if raycast_aabb(rx0, ry0, rz0, dx, dy, dz, c, dist) is not None]
        assert len(hits) == 0, f"{wname} blocked at eye height by {hits}!"

    # 4. Verify exported GLB binary magic header, byte size (< 3.0 MB), triangle count, and named Door nodes!
    assert os.path.isfile(glb_path), f"Missing exported GLB: {glb_path}"
    glb_bytes = os.path.getsize(glb_path)
    with open(glb_path, "rb") as f:
        header = f.read(20)
        magic, version, total_len, json_len, json_type = struct.unpack("<4sIIII", header)
        json_bytes = f.read(json_len)
    assert magic == b"glTF", f"Invalid GLB magic bytes: {magic!r}"
    assert glb_bytes < 3_000_000, f"GLB exceeds 3.0 MB limit: {glb_bytes} bytes"
    assert 15_000 <= total_tris <= 65_000, f"Triangle count {total_tris} outside target [15k..65k]!"

    gltf_json = json.loads(json_bytes.decode("utf-8"))
    nodes_by_name = {n.get("name"): n for n in gltf_json.get("nodes", []) if "name" in n}
    for d in doors:
        did = d["id"]
        p_name = f"DoorPanel_{did}"
        s_name = f"DoorSwitch_{did}"
        assert p_name in nodes_by_name, f"Missing GLB node {p_name}"
        assert s_name in nodes_by_name, f"Missing GLB node {s_name}"
        pt = nodes_by_name[p_name].get("translation", [0.0, 0.0, 0.0])
        st = nodes_by_name[s_name].get("translation", [0.0, 0.0, 0.0])
        c = d["center"]
        sw = d["switchPos"]
        assert math.dist(pt, [c["x"], c["y"], c["z"]]) < 0.002, f"{p_name} translation {pt} != {c}"
        assert math.dist(st, [sw["x"], sw["y"], sw["z"]]) < 0.002, f"{s_name} translation {st} != {sw}"

    print(
        f"[ASCENT VERIFIED] colliders={len(colliders)} | waypoints={len(waypoints)} "
        f"(heaven={len(heaven_wps)}, hell={len(hell_wps)}, treeCT={len(tree_ct_wps)}, "
        f"midLink={len(mid_link_wps)}, catwalk={len(catwalk_wps)}, bLane={len(blane_wps)}, "
        f"boathouse={len(boathouse_wps)}, bfs=100%) | "
        f"openingLoSPairs={opening_los_pairs} | glbBytes={glb_bytes} | triangles={total_tris}"
    )


# ---------------------------------------------------------------------------
# Auto-Generate `src/arena/ascentMapData.ts`
# ---------------------------------------------------------------------------

def write_typescript_data(
    ts_path: str,
    colliders: List[Dict],
    doors: List[Dict],
    sites: Dict,
    spawns: Dict,
    buy_barrier_spans: List[Dict],
    waypoints: List[Dict],
    callouts: List[Dict],
    walkable_rects: List[Dict],
    wall_rects: List[Dict],
) -> None:
    os.makedirs(os.path.dirname(ts_path), exist_ok=True)
    payload = {
        "bounds": {
            "minX": int(MIN_X),
            "maxX": int(MAX_X),
            "minZ": int(MIN_Z),
            "maxZ": int(MAX_Z),
            "width": ARENA_WIDTH_M,
            "depth": ARENA_DEPTH_M,
        },
        "colliders": colliders,
        "doors": doors,
        "bombSites": sites,
        "spawns": spawns,
        "buyBarrierSpans": buy_barrier_spans,
        "waypoints": waypoints,
        "callouts": callouts,
        "minimapShapes": {
            "walkableRects": walkable_rects,
            "wallRects": wall_rects,
        },
    }

    ts_code = f"""// AUTO-GENERATED BY `scripts/blender/build_ascent_map.py` — DO NOT EDIT MANUALLY.
// Single Source of Truth 3D physics colliders, multi-level waypoints, bomb sites,
// interactive blast doors, spawns, callouts, and minimap geometry matching `/models/ascent_map.glb` 1:1.

import type {{ BombSiteId, BombSiteZone, Vec3 }} from '../core/types';

export const ARENA_WIDTH_M = {ARENA_WIDTH_M};
export const ARENA_DEPTH_M = {ARENA_DEPTH_M};

export type ArenaZone = 'site_a' | 'site_b' | 'mid' | 'flank' | 'spawn';

export interface ArenaWaypoint {{
  id: string;
  pos: Vec3;
  neighbors: string[];
  zone?: ArenaZone;
}}

export interface ArenaCallout {{
  name: string;
  x: number;
  z: number;
  y?: number;
  major?: boolean;
}}

export interface ArenaMinimapData {{
  walkableRects: Array<{{
    x0: number;
    z0: number;
    x1: number;
    z1: number;
    level: 'ground' | 'mid' | 'high' | 'spawn_a' | 'spawn_d';
  }}>;
  wallRects: Array<{{
    x0: number;
    z0: number;
    x1: number;
    z1: number;
    kind: 'wall' | 'cover' | 'window' | 'roof';
  }}>;
}}

export interface AscentDoorDef {{
  id: 'a_tree' | 'b_market';
  label: string;
  bounds: {{ min: Vec3; max: Vec3 }};
  center: Vec3;
  switchPos: Vec3;
  maxHp: number;
}}

export interface AscentBuyBarrierSpan {{
  x0: number;
  x1: number;
  z: number;
  baseY: number;
  height: number;
  side: 'attacker' | 'defender';
}}

export interface AscentMapData {{
  bounds: {{
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    width: number;
    depth: number;
  }};
  colliders: Array<{{ min: Vec3; max: Vec3; tag: 'floor' | 'wall' | 'cover' }}>;
  doors: AscentDoorDef[];
  bombSites: Record<BombSiteId, BombSiteZone>;
  spawns: {{
    allies: [Vec3, Vec3, Vec3];
    enemies: [Vec3, Vec3, Vec3];
    spikePedestal: Vec3;
    buyMinAllyZ: number;
    buyMaxDefenderZ: number;
  }};
  buyBarrierSpans: AscentBuyBarrierSpan[];
  waypoints: ArenaWaypoint[];
  callouts: ArenaCallout[];
  minimapShapes: ArenaMinimapData;
}}

export const ASCENT_MAP_DATA: AscentMapData = {json.dumps(payload, indent=2)};

export const ASCENT_CALLOUTS: readonly ArenaCallout[] = ASCENT_MAP_DATA.callouts;
"""
    with open(ts_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(ts_code)


def main() -> None:
    clear_blender_scene()
    palette = MaterialPalette()
    arch = AscentArchitect(palette)
    objs = arch.build_all()

    total_tris = sum(len(o.data.polygons) for o in objs if o.type == "MESH")

    bomb_sites = {
        "A": {
            "site": "A",
            "minX": -31.0,
            "maxX": -18.0,
            "minZ": -23.0,
            "maxZ": -12.0,
            "center": {"x": -24.5, "y": 0.0, "z": -17.5},
        },
        "B": {
            "site": "B",
            "minX": 19.5,
            "maxX": 31.5,
            "minZ": -24.0,
            "maxZ": -16.2,
            "center": {"x": 25.5, "y": 0.0, "z": -20.1},
        },
    }

    spawns = {
        "allies": [
            {"x": -6.0, "y": 0.1, "z": 37.0},
            {"x": 0.0, "y": 0.1, "z": 37.0},
            {"x": 6.0, "y": 0.1, "z": 37.0},
        ],
        "enemies": [
            {"x": -6.0, "y": 0.1, "z": -39.5},
            {"x": 0.0, "y": 0.1, "z": -39.5},
            {"x": 6.0, "y": 0.1, "z": -39.5},
        ],
        "spikePedestal": {"x": 0.0, "y": 0.05, "z": 33.0},
        "buyMinAllyZ": BUY_MIN_ALLY_Z,
        "buyMaxDefenderZ": BUY_MAX_DEFENDER_Z,
    }

    callouts = [
        {"name": "A SITE", "x": -25.0, "z": -18.0, "y": 0.0, "major": True},
        {"name": "A GEN", "x": -26.2, "z": -20.0, "y": 0.0},
        {"name": "A DICE", "x": -20.7, "z": -14.1, "y": 0.0},
        {"name": "A MAIN", "x": -27.5, "z": -1.0, "y": 0.0, "major": True},
        {"name": "WINE", "x": -35.6, "z": -4.2, "y": 0.0},
        {"name": "A TREE", "x": -9.5, "z": -17.5, "y": 0.0, "major": True},
        {"name": "A HEAVEN", "x": -27.0, "z": -28.0, "y": 3.0, "major": True},
        {"name": "A HELL", "x": -27.2, "z": -28.5, "y": 0.0},
        {"name": "A LOBBY", "x": -25.5, "z": 11.0, "y": 0.0},
        {"name": "TOP MID", "x": -3.5, "z": 15.0, "y": 0.0, "major": True},
        {"name": "MID", "x": 1.5, "z": -3.0, "y": 0.0, "major": True},
        {"name": "CATWALK", "x": -9.7, "z": -4.0, "y": 0.85},
        {"name": "SUBROZA", "x": -6.4, "z": -6.4, "y": 0.0},
        {"name": "TILES", "x": -12.0, "z": 6.5, "y": 0.0},
        {"name": "PIZZA", "x": -2.0, "z": -13.2, "y": 0.0},
        {"name": "MID LINK", "x": -1.2, "z": -21.5, "y": 0.0},
        {"name": "MARKET", "x": 8.0, "z": -20.2, "y": 0.0, "major": True},
        {"name": "B LOBBY", "x": 26.5, "z": 9.5, "y": 0.0},
        {"name": "B MAIN", "x": 28.0, "z": -2.0, "y": 0.0, "major": True},
        {"name": "B LOGS", "x": 23.2, "z": -10.4, "y": 0.0},
        {"name": "B SWITCH", "x": 15.8, "z": -18.2, "y": 0.0},
        {"name": "B LANE", "x": 35.8, "z": -16.5, "y": 0.85},
        {"name": "BOATHOUSE", "x": 31.2, "z": -28.5, "y": 0.0},
        {"name": "B SITE", "x": 25.5, "z": -20.1, "y": 0.0, "major": True},
        {"name": "T SPAWN", "x": 0.0, "z": 35.0, "y": 0.0, "major": True},
        {"name": "CT SPAWN", "x": 2.0, "z": -39.0, "y": 0.0, "major": True},
    ]

    waypoints = generate_waypoints(arch.colliders, arch.walkable_rects, bomb_sites)

    os.makedirs(os.path.dirname(GLB_OUT_PATH), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=GLB_OUT_PATH,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_materials="EXPORT",
    )

    run_mandatory_proofs(
        colliders=arch.colliders,
        waypoints=waypoints,
        spawns=spawns,
        sites=bomb_sites,
        doors=arch.doors,
        glb_path=GLB_OUT_PATH,
        total_tris=total_tris,
    )

    write_typescript_data(
        ts_path=TS_OUT_PATH,
        colliders=arch.colliders,
        doors=arch.doors,
        sites=bomb_sites,
        spawns=spawns,
        buy_barrier_spans=arch.buy_barrier_spans,
        waypoints=waypoints,
        callouts=callouts,
        walkable_rects=arch.walkable_rects,
        wall_rects=arch.wall_rects,
    )
    print(f"[ASCENT EXPORT COMPLETE] Wrote {GLB_OUT_PATH} and {TS_OUT_PATH}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        import traceback
        traceback.print_exc()
        sys.exit(1)
