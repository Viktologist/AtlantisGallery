import {Matrix4,BufferAttribute} from '../../vendor/tidewater/src/engine/index.js';
import {concatenateVegetation} from './vegetation_geometry.js';

const nearSchemas=new Set(['plantfactory-grass-patch/v1','atlantis-plants-grass-patch/v1']);
const farSchemas=new Set(['plantfactory-grass-impostor/v1','atlantis-plants-grass-impostor/v1']);
export const isNativeGrassPatch=document=>nearSchemas.has(document?.extras?.schema);
export function nativeImpostorNormalFrame(document){
 if(document.extras?.plantfactory_impostor?.foliage_optics)return 'impostor-local';
 const materials=document.materials??[];
 return farSchemas.has(document.extras?.schema)&&document.extras?.impostor?.source_mesh_scaled===false&&
  materials.length>0&&materials.every(m=>m.alphaMode==='MASK'&&m.doubleSided&&m.extras?.principled?.diffuseTransmission>0)?'impostor-local':'surface';
}

                                                                                
                                                                                 
                                               
export function packNativeGrassPatch(rows,{expectedTriangles}={}){
 if(!rows.length)throw Error('Empty native grass patch');
 const parts=[],materials=[],materialIDs=new Map(),ids=[];
 try{
  for(const row of rows){
   if(row.deformed||row.mesh.material.transparent||!row.mesh.geometry.index)throw Error('Native grass patch requires static indexed opaque/MASK facesets');
   const mesh=row.mesh;
   if(mesh.parent)mesh.updateWorldMatrix(true,false);
   const key=row.materialIndex??mesh.material;
   if(!materialIDs.has(key)){materialIDs.set(key,materials.length);materials.push(mesh.material);}
   for(let i=0;i<mesh.count;i++){
    const local=new Matrix4();if(mesh.isInstancedMesh)mesh.getMatrixAt(i,local);
    const world=new Matrix4().multiplyMatrices(mesh.matrixWorld,local);
    const geometry=mesh.geometry.clone().applyMatrix4(world);
    parts.push(geometry);ids.push(materialIDs.get(key));
   }
  }
                                                                                
  const packed=concatenateVegetation(parts,{facesets:true}).geometry;
  const faceIDs=new Uint32Array(packed.attributes.position.count);let at=0;
  parts.forEach((g,i)=>{faceIDs.fill(ids[i],at,at+g.attributes.position.count);at+=g.attributes.position.count;});
  packed.setAttribute('apsFaceset',new BufferAttribute(faceIDs,1));
  if(expectedTriangles!==undefined&&packed.index.count!==expectedTriangles*3){packed.dispose();throw Error('Native grass patch triangle readback differs from its receipt');}
  return {geometry:packed,materials,triangles:packed.index.count/3,occurrences:parts.length};
 }finally{for(const part of parts)part.dispose();}
}
import {primitiveGeometry} from './mesh_gltf.js';

                                                                           
                                                         
export function packNativeGrassLODLevels(rows,parsed,{expectedTriangles}={}){
 const packed=[];
 try{
  for(let level=0;level<3;level++){
   const temporary=[];
   try{
    const selected=rows.map(row=>{
     const mesh=row.mesh,ids=mesh.userData?.aps_vegetation_lods??parsed.json.meshes[row.meshIndex]?.extras?.aps_vegetation_lods;
     if(!ids||ids.length!==3)throw Error('Native grass requires load-time LOD construction before packing');
     if(mesh.userData?.aps_deformed||parsed.animations?.length)throw Error('Native grass LOD requires static geometry');
     let geometry=mesh.geometry;
     if(level){const primitive=parsed.meshes[ids[level]]?.[row.primitiveIndex];if(!primitive||primitive.material!==row.materialIndex)throw Error('Native grass LOD material identity changed');geometry=primitiveGeometry(primitive).geometry;temporary.push(geometry);}
     const proxy={geometry,material:mesh.material,count:mesh.count,isInstancedMesh:mesh.isInstancedMesh,matrixWorld:mesh.matrixWorld.clone(),parent:null,getMatrixAt:(i,m)=>mesh.getMatrixAt(i,m)};
     return {...row,mesh:proxy,deformed:false};
    });
    packed.push(packNativeGrassPatch(selected,level===0?{expectedTriangles}:{}));
   }finally{for(const geometry of temporary)geometry.dispose();}
  }
  if(packed[1].triangles>packed[0].triangles||packed[2].triangles>packed[1].triangles)throw Error('Native grass LOD triangle counts must not increase');
  return packed;
 }catch(error){for(const p of packed)p.geometry.dispose();throw error;}
}
