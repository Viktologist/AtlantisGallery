import {grassDensityRank} from './grass_density.js';

                                                                          
                                                                             
export function importedProjectionDensity(bounds,{overlap=4}={}){
 const lo=bounds.min.toArray?.()??bounds.min,hi=bounds.max.toArray?.()??bounds.max;
 if(!Array.isArray(lo)||!Array.isArray(hi)||lo.length!==3||hi.length!==3||![...lo,...hi,overlap].every(Number.isFinite)||overlap<=0||lo.some((v,i)=>v>hi[i]))throw Error('Invalid prototype density bounds/overlap');
 const size=hi.map((v,i)=>v-lo[i]),diameter=Math.max(size[0],size[2]),footprint=Math.PI*diameter*diameter/4;
 return Object.freeze({schema:'aps-bbox-projection-density/1',bounds_min:[...lo],bounds_max:[...hi],diameter_m:diameter,footprint_m2:footprint,nominal_overlap:overlap,target_root_area_m2:footprint/overlap,formula:'p=min(1,max(source_cell_area/(bbox_disc_area/overlap*instance_XZ_area_scale),near_boundary_area/projected_bbox_area))',coverage_measured:false});
}

export function projectedGrassRetention(area,sourceCellArea,targetRootArea,{boundaryArea=1024,areaScale=1}={}){
 if(!(area>0&&sourceCellArea>0&&targetRootArea>=0&&boundaryArea>0&&areaScale>0))throw Error('Invalid projected grass density inputs');
 const floor=targetRootArea===0?1:sourceCellArea/(targetRootArea*areaScale);
 return Math.min(1,Math.max(floor,boundaryArea/area));
}
export const projectionDensityRank=key=>grassDensityRank(key^0x68bc21eb);
export const GRASS_PROJECTION_DENSITY_WGSL=          `
fn apsGrassProjectionRetention(a:f32,m:mat4x4f)->f32{
 if(p.nearDensity.y==0.){return 1.;}
 let xzScale=max(abs(cross(m[0].xyz,m[2].xyz).y),1e-6);
 let floor=p.anchor.x*p.anchor.x/max(p.nearDensity.x*xzScale,1e-20);
 return clamp(max(floor,p.policy.x/max(a,p.policy.x)),0.,1.);
}
fn apsGrassProjectionKeep(key:u32,a:f32,m:mat4x4f)->bool{
 return apsGrassDensityRank(key^0x68bc21ebu)<apsGrassProjectionRetention(a,m);
}
`;
