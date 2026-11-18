import {Matrix4} from '../../vendor/tidewater/src/engine/math/Matrix4.js';
import {Vector3} from '../../vendor/tidewater/src/engine/math/Vector3.js';

                                                                          
                                                                          
                                                                          
function linearNormBound(matrix) {
  const e=matrix.elements;
  const rows=[0,1,2].map(r=>Math.abs(e[r])+Math.abs(e[4+r])+Math.abs(e[8+r]));
  const cols=[0,1,2].map(c=>Math.abs(e[4*c])+Math.abs(e[4*c+1])+Math.abs(e[4*c+2]));
  return Math.sqrt(Math.max(...rows)*Math.max(...cols));
}

                                                                             
                                                                                
export function terrainCoordinates(rootMatrix, origin) {
  const worldFromMesh = new Matrix4().copy(rootMatrix);
  if (!Number.isFinite(worldFromMesh.determinant()) || Math.abs(worldFromMesh.determinant()) < 1e-15)
    throw Error('Terrain root transform is not invertible');
  const meshFromWorld = worldFromMesh.clone().invert();
  const worldFromNative = worldFromMesh.clone().multiply(new Matrix4().makeTranslation(-origin[0], 0, -origin[1]));
  return {
    worldFromNative,
    nativeFromWorld: worldFromNative.clone().invert(),
                                                                           
                                                                               
    projectionScaleBound: linearNormBound(worldFromMesh)*linearNormBound(meshFromWorld),
    meshPoint(point) { return new Vector3().fromArray(point).applyMatrix4(meshFromWorld).toArray(); },
    nativeClip(viewProj) { return new Matrix4().multiplyMatrices(viewProj, worldFromNative); },
    worldBounds(bounds) {
      const min=[Infinity,Infinity,Infinity], max=[-Infinity,-Infinity,-Infinity];
      for (const x of [bounds.min[0],bounds.max[0]])
        for (const y of [bounds.min[1],bounds.max[1]])
          for (const z of [bounds.min[2],bounds.max[2]]) {
            const point=new Vector3(x,y,z).applyMatrix4(worldFromNative).toArray();
            for(let i=0;i<3;i++){min[i]=Math.min(min[i],point[i]);max[i]=Math.max(max[i],point[i]);}
          }
      return {min,max};
    },
  };
}

                                                                          
                                                                           
export function terrainCasterBounds(scene, root = null, displacement = 0) {
  const origin=scene.origin_xz_m??[0,0],extent=scene.extent_xz_m;
  const stages=Object.values(scene.stages??{});
  const min=Math.min(...stages.map(s=>s.min_m)),max=Math.max(...stages.map(s=>s.peak_m));
  if(!extent||![...origin,...extent,min,max,displacement].every(Number.isFinite)||displacement<0)
    throw Error('Native terrain caster bounds missing');
  const bounds={min:[origin[0],min-displacement,origin[1]],max:[origin[0]+extent[0],max+displacement,origin[1]+extent[1]]};
  if(!root)return bounds;
  root.updateWorldMatrix(true,false);
  return terrainCoordinates(root.matrixWorld,origin).worldBounds(bounds);
}
