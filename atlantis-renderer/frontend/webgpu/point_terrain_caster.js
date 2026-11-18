import {Mesh} from '../../vendor/tidewater/src/engine/scene/Mesh.js';
import {terrainPatchGeometry} from './terrain_geometry.js';
import {InstancedBufferGeometry} from '../../vendor/tidewater/src/engine/geometry/BufferGeometry.js';
import {InstancedBufferAttribute} from '../../vendor/tidewater/src/engine/geometry/BufferAttribute.js';
import {boxIntersectsClip} from './point_light_math.js';

                                                                                 
                                                                                
export function createPointTerrainCaster({tiles,viewProj,material,matrixWorld,segments=64,grid=null}){
 const rows=tiles.filter(tile=>boxIntersectsClip(tile,viewProj)).map(tile=>tile.patch);
 if(!rows.length)return null;
 const geometry=grid?new InstancedBufferGeometry():terrainPatchGeometry(rows.length,{skirts:false,segments});
 if(grid){geometry.setAttribute('position',grid.attributes.position);geometry.setIndex(grid.index);geometry.setAttribute('apsPatch',new InstancedBufferAttribute(new Float32Array(rows.length*4),4));geometry.userData.apsPointTerrainGrid=grid;geometry.userData.apsStaticIndexOwner=grid;}
 rows.forEach((row,i)=>geometry.attributes.apsPatch.array.set(row,i*4));geometry.attributes.apsPatch.needsUpdate=true;geometry.instanceCount=rows.length;
 const caster=new Mesh(geometry,material);caster.matrixWorld.copy(matrixWorld);caster.matrixAutoUpdate=false;caster.frustumCulled=false;caster.castShadow=true;caster.staticVelocity=true;return caster;
}
