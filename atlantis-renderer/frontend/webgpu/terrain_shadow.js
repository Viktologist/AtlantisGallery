                                                                              
                                                                                
                                                                              
export function nativeShadowTiles(native) {
  const {shape:[nz,nx],spacing:[dx,dz],origin:[ox,oz],data}=native,tiles=[];
  for(let z=0;z<nz-1;z+=64)for(let x=0;x<nx-1;x+=64){
    const x1=Math.min(x+64,nx-1),z1=Math.min(z+64,nz-1);
    let low=Infinity,high=-Infinity;
    for(let j=z;j<=z1;j++)for(let i=x;i<=x1;i++){const h=data[j*nx+i];low=Math.min(low,h);high=Math.max(high,h);}
    tiles.push({patch:[x,z,64,0],min:[ox+x*dx,low,oz+z*dz],max:[ox+x1*dx,high,oz+z1*dz]});
  }
  return tiles;
}

export function selectNativeShadowTiles(tiles,viewProj,padding=0) {
  const m=viewProj.elements??viewProj,out=[];
  for(const tile of tiles){
                                                                               
    const center=tile.min.map((v,i)=>(v+tile.max[i])*.5),half=tile.min.map((v,i)=>(tile.max[i]-v)*.5);
    let outside=false;
    for(let axis=0;axis<3;axis++){
      const p=m[axis]*center[0]+m[axis+4]*center[1]+m[axis+8]*center[2]+m[axis+12];
      const r=Math.abs(m[axis])*half[0]+Math.abs(m[axis+4])*half[1]+Math.abs(m[axis+8])*half[2];
      const lo=axis===2?0:-1-padding,hi=1+padding;
      if(p+r<lo||p-r>hi){outside=true;break;}
    }
    if(!outside)out.push(tile.patch);
  }
  return out;
}

export const nativeShadowVertexWGSL=`
let q=vec2i(min(v.apsPatch.xy+v.position.xz,terrainParams.shape-1.0));
v.position=vec3f(f32(q.x)*terrainParams.spacing.x,textureLoad(terrainHeight,q,0).r,f32(q.y)*terrainParams.spacing.y);
`;
