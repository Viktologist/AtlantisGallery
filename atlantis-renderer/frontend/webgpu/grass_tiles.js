export const GRASS_TILE_SIDE=64;

                                                                            
                                                                                
export function buildGrassTiles(world,region,native,radius){
 const shape=world.shape.map(n=>Math.ceil(n/GRASS_TILE_SIDE)),bounds=new Float32Array(shape[0]*shape[1]*8);
 const [nz,nx]=native.shape,[ox,oz]=native.origin,[dx,dz]=native.spacing;
 if(!native.data||native.data.length!==nx*nz)throw Error('Grass tile bounds require the native DEM');
 let occupied=0;
 for(let z=0;z<shape[1];z++)for(let x=0;x<shape[0];x++){
  const lo=[(world.min[0]+x*GRASS_TILE_SIDE)*world.step,(world.min[1]+z*GRASS_TILE_SIDE)*world.step];
  const hi=[(world.min[0]+Math.min((x+1)*GRASS_TILE_SIDE,world.shape[0]))*world.step,(world.min[1]+Math.min((z+1)*GRASS_TILE_SIDE,world.shape[1]))*world.step];
  const a=lo.map((v,i)=>Math.max(0,Math.floor((v-region.min[i])/region.extent[i]*[region.width,region.height][i]))),b=hi.map((v,i)=>Math.min([region.width,region.height][i]-1,Math.ceil((v-region.min[i])/region.extent[i]*[region.width,region.height][i])-1));
  let planted=false;for(let j=a[1];j<=b[1]&&!planted;j++)for(let i=a[0];i<=b[0];i++)if(region.data[j*region.width+i]){planted=true;break;}
  if(!planted)continue;
  const ix0=Math.max(0,Math.floor((lo[0]-ox)/dx)),ix1=Math.min(nx-1,Math.ceil((hi[0]-ox)/dx)),iz0=Math.max(0,Math.floor((lo[1]-oz)/dz)),iz1=Math.min(nz-1,Math.ceil((hi[1]-oz)/dz));
  let min=Infinity,max=-Infinity;for(let j=iz0;j<=iz1;j++)for(let i=ix0;i<=ix1;i++){const h=native.data[j*nx+i];min=Math.min(min,h);max=Math.max(max,h);}
  if(!Number.isFinite(min))continue;
  bounds.set([(lo[0]+hi[0])*.5,(min+max)*.5,(lo[1]+hi[1])*.5,1,(hi[0]-lo[0])*.5+radius,(max-min)*.5+radius,(hi[1]-lo[1])*.5+radius,0],(z*shape[0]+x)*8);occupied++;
 }
 return {shape,bounds,occupied};
}

                                                                             
                                                                              
                                                                                 
export function grassFarClipW(vp,width,height,radius,minArea){
 const norm=k=>Math.abs(vp[k])+Math.abs(vp[4+k])+Math.abs(vp[8+k]),w=norm(3);
 return radius*w+radius*Math.sqrt(width*height*(norm(0)+w)*(norm(1)+w)/minArea);
}
