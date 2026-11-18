                                                                            
                                                              
export function grassRegion(source,worldBounds,localBounds,size=512,cells=null){
 const matrix=source.matrixWorld.elements,a=source.instanceMatrix.array;
 if(cells)return {data:cells.data,width:cells.shape[1],height:cells.shape[0],min:cells.origin,extent:cells.extent,scale:[1,1,1],method:'registered native terrain CELL grass eligibility; nearest cell lookup'};
 const min=[worldBounds.min.x,worldBounds.min.z],extent=[worldBounds.max.x-min[0],worldBounds.max.z-min[1]].map(v=>Math.max(v,.01));
 const data=new Uint8Array(size*size),scale=[0,1,2].map(k=>Math.hypot(a[k*4],a[k*4+1],a[k*4+2]));
 const radius=Math.max(localBounds.max.x-localBounds.min.x,localBounds.max.z-localBounds.min.z)*.5*Math.max(...scale);
 const rx=Math.min(size,Math.max(1,Math.ceil(radius/extent[0]*size))),rz=Math.min(size,Math.max(1,Math.ceil(radius/extent[1]*size)));
 for(let i=0;i<source.count;i++){
  const at=i*16,x=matrix[0]*a[at+12]+matrix[4]*a[at+13]+matrix[8]*a[at+14]+matrix[12],z=matrix[2]*a[at+12]+matrix[6]*a[at+13]+matrix[10]*a[at+14]+matrix[14];
  const ix=Math.floor((x-min[0])/extent[0]*size),iz=Math.floor((z-min[1])/extent[1]*size);
  for(let dz=-rz;dz<=rz;dz++)for(let dx=-rx;dx<=rx;dx++){
   const u=ix+dx,v=iz+dz;if(u<0||u>=size||v<0||v>=size||(dx/rx)**2+(dz/rz)**2>1)continue;
   data[v*size+u]=255;
  }
 }
 return {data,size,width:size,height:size,min,extent,scale,method:'occupied native anchor cells expanded by the native grass footprint; raster approximation'};
}
