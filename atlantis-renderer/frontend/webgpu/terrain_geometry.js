import {BufferGeometry, InstancedBufferGeometry} from '../../vendor/tidewater/src/engine/geometry/BufferGeometry.js';
import {BufferAttribute, Float32BufferAttribute, InstancedBufferAttribute} from '../../vendor/tidewater/src/engine/geometry/BufferAttribute.js';
import {DynamicDrawUsage} from '../../vendor/tidewater/src/engine/constants.js';

                                                                                
                                                                             
                                                                             
export function terrainPatchGeometry(capacity, {skirts = true,segments = 64,seams = false} = {}) {
  if(!Number.isInteger(segments)||segments<1||segments>512||(segments&(segments-1)))throw Error('Invalid terrain patch subdivisions');
  const positions = [], indices = [], border = [];
  const stride=segments+1;
  for (let z = 0; z <= segments; z++) for (let x = 0; x <= segments; x++) positions.push(x*64/segments, 0, z*64/segments);
  for (let z = 0; z < segments; z++) for (let x = 0; x < segments; x++) {
    const i = z * stride + x; indices.push(i, i + stride, i + 1, i + 1, i + stride, i + stride+1);
  }
  if (skirts) for (let x = 0; x <= segments; x++) border.push(x);
  if (skirts) for (let z = 1; z <= segments; z++) border.push(z * stride + segments);
  if (skirts) for (let x = segments-1; x >= 0; x--) border.push(segments * stride + x);
  if (skirts) for (let z = segments-1; z > 0; z--) border.push(z * stride);
  const base = positions.length / 3;
  for (const i of border) positions.push(positions[i * 3], 1, positions[i * 3 + 2]);
  for (let j = 0; j < border.length; j++) {
    const k = (j + 1) % border.length; indices.push(border[j], base + j, border[k], border[k], base + j, base + k);
  }
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.setAttribute('apsPatch', new InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(DynamicDrawUsage));
  if(seams)geometry.setAttribute('apsSeam',new InstancedBufferAttribute(new Float32Array(capacity*4),4).setUsage(DynamicDrawUsage));
  geometry.instanceCount = 0;
  return geometry;
}

                                                                          
export function savedWaterGeometry(points, indices = null) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
  if (indices) geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}
