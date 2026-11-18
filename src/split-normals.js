import { Float32BufferAttribute, Vector3 } from 'three';

// USD point indices preserve the original topology after the loader expands faces.
export const usdPointIndices = new WeakMap();
export const usdFaceNormals = new WeakSet();

const CORNER_NORMAL_EPSILON = 1e-5;
const nextCorner = corner => corner % 3 === 2 ? corner - 2 : corner + 1;

function coincidentPoints(position) {
  const ids = new Uint32Array(position.count);
  const points = new Map();
  for (let i = 0; i < position.count; i++) {
    const key = [position.getX(i), position.getY(i), position.getZ(i)].join(',');
    if (!points.has(key)) points.set(key, points.size);
    ids[i] = points.get(key);
  }
  return ids;
}

export function splitGeometryNormals(geometry, creaseDegrees = 45) {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index?.count ?? position?.count;
  if (!position || !count || count % 3 !== 0) return geometry;

  const original = geometry.getAttribute('normal');
  const pointIDs = usdPointIndices.get(geometry) ?? coincidentPoints(position);
  const hasAuthoredFaceNormals = usdFaceNormals.has(geometry);
  const vertices = new Uint32Array(count);
  const parents = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    vertices[i] = index ? index.getX(i) : i;
    parents[i] = i;
  }
  function find(corner) {
    while (parents[corner] !== corner) {
      parents[corner] = parents[parents[corner]];
      corner = parents[corner];
    }
    return corner;
  }

  const directions = new Float64Array(count);
  const angles = new Float32Array(count);
  const edges = new Map();
  const points = [new Vector3(), new Vector3(), new Vector3()];
  const a = new Vector3(), b = new Vector3(), normal = new Vector3();
  for (let start = 0; start < count; start += 3) {
    for (let i = 0; i < 3; i++) points[i].fromBufferAttribute(position, vertices[start + i]);
    a.subVectors(points[1], points[0]);
    b.subVectors(points[2], points[0]);
    normal.crossVectors(a, b);
    const length = normal.length();
    if (!Number.isFinite(length) || length === 0) continue;
    normal.divideScalar(length).toArray(directions, start);
    for (let i = 0; i < 3; i++) {
      const corner = start + i;
      a.subVectors(points[(i + 1) % 3], points[i]);
      b.subVectors(points[(i + 2) % 3], points[i]);
      angles[corner] = Math.atan2(normal.crossVectors(a, b).length(), a.dot(b));
      const from = pointIDs[vertices[corner]], to = pointIDs[vertices[nextCorner(corner)]];
      const key = from < to ? from + ':' + to : to + ':' + from;
      const edge = edges.get(key);
      if (!edge) edges.set(key, { corner, from, other: -1 });
      else if (edge.other === -1 && edge.from === to) edge.other = corner;
      else edge.other = -2; // Non-manifold or inconsistent winding.
    }
  }

  const limit = Math.cos(creaseDegrees * Math.PI / 180);
  const rebuild = new Uint8Array(count);
  const authoredA = new Vector3(), authoredB = new Vector3();
  function readAuthored(target, vertex) {
    if (!original || vertex >= original.count) return false;
    target.fromBufferAttribute(original, vertex);
    const length = target.length();
    if (!Number.isFinite(length) || length <= CORNER_NORMAL_EPSILON) return false;
    target.divideScalar(length);
    return true;
  }
  function connect(first, second, sharp) {
    const hasA = readAuthored(authoredA, vertices[first]);
    const hasB = readAuthored(authoredB, vertices[second]);
    const authoredSplit = hasA && hasB && authoredA.dot(authoredB) < 1 - CORNER_NORMAL_EPSILON;
    if (authoredSplit) return;
    if (sharp && !(hasAuthoredFaceNormals && hasA && hasB)) {
      rebuild[first] = rebuild[second] = 1;
    } else if (!sharp) {
      parents[find(second)] = find(first);
    }
  }
  for (const { corner, other } of edges.values()) {
    if (other < 0) continue;
    a.fromArray(directions, corner - corner % 3);
    b.fromArray(directions, other - other % 3);
    const sharp = a.dot(b) < limit - 1e-6;
    connect(corner, nextCorner(other), sharp);
    connect(nextCorner(corner), other, sharp);
  }

  const weighted = new Float64Array(count * 3);
  const rebuildGroup = new Uint8Array(count);
  for (let corner = 0; corner < count; corner++) {
    const group = find(corner);
    if (rebuild[corner]) rebuildGroup[group] = 1;
    const dest = group * 3, face = corner - corner % 3;
    for (let axis = 0; axis < 3; axis++) weighted[dest + axis] += directions[face + axis] * angles[corner];
  }

  const perVertex = new Float32Array(position.count * 3);
  const perCorner = index ? new Float32Array(count * 3) : perVertex;
  const visited = new Uint8Array(position.count);
  let needsSplit = false;
  let changed = !original || original.count !== position.count;
  for (let corner = 0; corner < count; corner++) {
    const vertex = vertices[corner], group = find(corner);
    const authored = readAuthored(a, vertex);
    if (authored && !rebuildGroup[group]) normal.copy(a);
    else normal.fromArray(weighted, group * 3).normalize();
    if (normal.lengthSq() === 0) {
      normal.fromArray(directions, corner - corner % 3);
      if (normal.lengthSq() === 0) normal.set(0, 1, 0);
    }
    normal.toArray(perCorner, corner * 3);
    if (visited[vertex]) {
      b.fromArray(perVertex, vertex * 3);
      if (b.dot(normal) < 1 - CORNER_NORMAL_EPSILON) needsSplit = true;
    } else {
      visited[vertex] = 1;
      normal.toArray(perVertex, vertex * 3);
    }
    changed ||= !authored || a.dot(normal) < 1 - CORNER_NORMAL_EPSILON;
  }
  for (let vertex = 0; vertex < position.count; vertex++) {
    if (visited[vertex]) continue;
    if (!readAuthored(normal, vertex)) normal.set(0, 1, 0);
    normal.toArray(perVertex, vertex * 3);
  }

  const result = needsSplit ? geometry.toNonIndexed() : geometry;
  if (needsSplit) {
    result.name = geometry.name;
    result.userData = geometry.userData;
    result.setDrawRange(geometry.drawRange.start, geometry.drawRange.count);
  }
  result.setAttribute('normal', new Float32BufferAttribute(needsSplit ? perCorner : perVertex, 3));
  // The native material can rebuild the tangent frame from the UV derivatives.
  if (changed) result.deleteAttribute('tangent');
  return result;
}

export function prepareModelNormals(root, creaseDegrees) {
  const limit = Number.isFinite(creaseDegrees) ? Math.min(180, Math.max(0, creaseDegrees)) : 45;
  const converted = new Map();
  root.traverse(node => {
    if (!node.isMesh || !node.geometry) return;
    const source = node.geometry;
    if (!converted.has(source)) converted.set(source, splitGeometryNormals(source, limit));
    node.geometry = converted.get(source);
  });
  for (const [source, result] of converted) {
    if (source !== result) source.dispose();
    usdPointIndices.delete(source);
    usdFaceNormals.delete(source);
  }
}
