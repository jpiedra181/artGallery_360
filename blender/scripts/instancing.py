"""Fast instancing of small primitives with numpy.

bmesh operators slow down as a mesh grows, so scattering tens of thousands
of leaf clusters one `create_icosphere` at a time takes hours. Here the
primitive is built once and every copy is transformed in a single
vectorised step, then written to one mesh.
"""

import bmesh
import numpy as np

import printmaking as P

_CACHE = {}


def primitive(kind):
    """(verts N×3, faces M×k) of a unit primitive: 'ico' (radius 1,
    subdivided once), 'ico2' (subdivided twice), 'cube' (size 1)."""
    if kind in _CACHE:
        return _CACHE[kind]
    if kind == "ico0":
        # a plain icosahedron: 12 vertices, enough for tiny leaf clusters
        t = (1 + 5 ** 0.5) / 2
        v = np.array([(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t),
                      (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)], np.float32)
        v /= np.linalg.norm(v, axis=1, keepdims=True)
        f = np.array([(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2),
                      (10, 7, 6), (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5),
                      (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)], np.int32)
        _CACHE[kind] = (v, f)
        return v, f
    if kind == "leaf":
        # a pointed leaf: a flat diamond in the XY plane
        v = np.array([(0, -1, 0), (0.42, -0.1, 0), (0, 1, 0), (-0.42, -0.1, 0)], np.float32)
        f = np.array([(0, 1, 2, 3)], np.int32)
        _CACHE[kind] = (v, f)
        return v, f
    bm = bmesh.new()
    if kind == "ico":
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0)
    elif kind == "ico2":
        bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0)
    elif kind == "cube":
        bmesh.ops.create_cube(bm, size=1.0)
    bm.verts.ensure_lookup_table()
    v = np.array([vv.co[:] for vv in bm.verts], np.float32)
    f = np.array([[l.vert.index for l in face.loops] for face in bm.faces], np.int32)
    bm.free()
    _CACHE[kind] = (v, f)
    return v, f


def basis_from_dirs(d):
    """Rotation matrices (n×3×3) whose local Z points along each direction."""
    d = np.asarray(d, np.float64)
    z = d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
    up = np.where(np.abs(z[:, 2:3]) > 0.95, np.array([[1.0, 0, 0]]), np.array([[0, 0, 1.0]]))
    x = np.cross(up, z)
    x /= np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-9)
    y = np.cross(z, x)
    return np.stack([x, y, z], axis=2)  # columns


def random_rotations(n, rng):
    """Uniformly random rotation matrices (n×3×3) from random quaternions."""
    u1, u2, u3 = rng.random(n), rng.random(n), rng.random(n)
    q = np.stack([np.sqrt(1 - u1) * np.sin(2 * np.pi * u2), np.sqrt(1 - u1) * np.cos(2 * np.pi * u2),
                  np.sqrt(u1) * np.sin(2 * np.pi * u3), np.sqrt(u1) * np.cos(2 * np.pi * u3)], 1)
    x, y, z, w = q.T
    return np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], 1),
        np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], 1),
        np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], 1),
    ], 1)


def rot_z(angles):
    c, s = np.cos(angles), np.sin(angles)
    m = np.zeros((len(angles), 3, 3))
    m[:, 0, 0], m[:, 0, 1], m[:, 1, 0], m[:, 1, 1], m[:, 2, 2] = c, -s, s, c, 1
    return m


def build(name, kind, positions, scales, rotations=None, coll=None, per_instance=None):
    """One mesh with a copy of `kind` per instance.

    positions n×3, scales n×3 (or n), rotations n×3×3 (optional),
    per_instance: dict name -> n values, stored as point attributes.
    """
    v, f = primitive(kind)
    n = len(positions)
    pos = np.asarray(positions, np.float64)
    sc = np.asarray(scales, np.float64)
    if sc.ndim == 1:
        sc = np.repeat(sc[:, None], 3, axis=1)
    local = v[None, :, :] * sc[:, None, :]
    if rotations is not None:
        local = np.einsum("nij,nkj->nki", rotations, local)
    verts = (local + pos[:, None, :]).reshape(-1, 3)
    faces = (f[None, :, :] + (np.arange(n) * len(v))[:, None, None]).reshape(-1, f.shape[1])
    obj = P.mesh_from_arrays(name, verts, faces, coll)
    for attr, values in (per_instance or {}).items():
        P.add_point_attribute(obj, attr, np.repeat(np.asarray(values, np.float32), len(v)))
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def beams(name, starts, ends, widths, heights=None, coll=None):
    """Boxes from each start point to each end point."""
    a = np.asarray(starts, np.float64)
    b = np.asarray(ends, np.float64)
    d = b - a
    length = np.linalg.norm(d, axis=1)
    w = np.broadcast_to(np.asarray(widths, np.float64), length.shape)
    h = w if heights is None else np.broadcast_to(np.asarray(heights, np.float64), length.shape)
    rots = basis_from_dirs(d)
    scales = np.stack([w, h, length], axis=1)
    obj = build(name, "cube", (a + b) / 2, scales, rots, coll)
    for p in obj.data.polygons:
        p.use_smooth = False
    return obj
