                                                                               
export function buildShoreTiles(terrain, sea, hs, tileMetres=32, cells=128, halo=2, coast=null){
  if(!terrain)return {tiles:[],origin:[0,0],shape:[1,1],tileMetres,cells,halo};
  const {data,shape:[nz,nx],spacing,origin:nativeOrigin}=terrain;
  const origin=nativeOrigin.map(v=>Math.floor(v/tileMetres)*tileMetres);
  const shape=[Math.ceil((nativeOrigin[0]+(nx-1)*spacing[0]-origin[0])/tileMetres),Math.ceil((nativeOrigin[1]+(nz-1)*spacing[1]-origin[1])/tileMetres)];
  const ranges=Array.from({length:shape[0]*shape[1]},()=>[Infinity,-Infinity]);
  for(let z=0;z<nz;z++)for(let x=0;x<nx;x++){
    const tx=Math.min(shape[0]-1,Math.floor((nativeOrigin[0]+x*spacing[0]-origin[0])/tileMetres));
    const tz=Math.min(shape[1]-1,Math.floor((nativeOrigin[1]+z*spacing[1]-origin[1])/tileMetres));
    const r=ranges[tz*shape[0]+tx],h=data[z*nx+x]-sea;r[0]=Math.min(r[0],h);r[1]=Math.max(r[1],h);
  }
  const selected=new Set(),depth=Math.max(8,hs*24),runup=Math.max(.1,hs*3);
                                                                              
                                                                       
  for(let z=0;z<nz-1;z++)for(let x=0;x<nx-1;x++){
    const h00=data[z*nx+x],h10=data[z*nx+x+1],h01=data[(z+1)*nx+x],h11=data[(z+1)*nx+x+1];
    const low=Math.min(h00,h10,h01,h11)-sea,high=Math.max(h00,h10,h01,h11)-sea;if(low>runup||high<-depth)continue;
    const x0=Math.floor((nativeOrigin[0]+x*spacing[0]-origin[0])/tileMetres),z0=Math.floor((nativeOrigin[1]+z*spacing[1]-origin[1])/tileMetres);
    const x1=Math.min(shape[0]-1,Math.floor((nativeOrigin[0]+(x+1)*spacing[0]-origin[0])/tileMetres)),z1=Math.min(shape[1]-1,Math.floor((nativeOrigin[1]+(z+1)*spacing[1]-origin[1])/tileMetres));
    for(let tz=z0;tz<=z1;tz++)for(let tx=x0;tx<=x1;tx++){const r=ranges[tz*shape[0]+tx];r[0]=Math.min(r[0],low);r[1]=Math.max(r[1],high);}
  }
  for(let z=0;z<shape[1];z++)for(let x=0;x<shape[0];x++){
    const r=ranges[z*shape[0]+x];if(r[0]>runup||r[1]<-depth||!Number.isFinite(r[0]))continue;
    if(coast){
                                                                             
                                                                               
      const px=origin[0]+x*tileMetres,pz=origin[1]+z*tileMetres,n=coast.size;
      const x0=Math.max(0,Math.floor((px-coast.origin[0])/coast.extent[0]*n)-1),z0=Math.max(0,Math.floor((pz-coast.origin[1])/coast.extent[1]*n)-1);
      const x1=Math.min(n-1,Math.ceil((px+tileMetres-coast.origin[0])/coast.extent[0]*n)+1),z1=Math.min(n-1,Math.ceil((pz+tileMetres-coast.origin[1])/coast.extent[1]*n)+1);
      let supported=false;for(let iz=z0;iz<=z1&&!supported;iz++)for(let ix=x0;ix<=x1;ix++)if(coast.data[(iz*n+ix)*4+3]>.00001){supported=true;break;}
      if(!supported)continue;
    }
                                                                                 
    for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<shape[0]&&z+dz>=0&&z+dz<shape[1])selected.add((z+dz)*shape[0]+x+dx);
  }
  const tiles=[...selected].sort((a,b)=>a-b).map((key,id)=>({id,key,x:key%shape[0],z:Math.floor(key/shape[0]),origin:[origin[0]+key%shape[0]*tileMetres,origin[1]+Math.floor(key/shape[0])*tileMetres]}));
  return {tiles,origin,shape,tileMetres,cells,halo};
}

export function shoreTileAt(layout,x,z){
  const tx=Math.floor((x-layout.origin[0])/layout.tileMetres),tz=Math.floor((z-layout.origin[1])/layout.tileMetres);
  if(tx<0||tz<0||tx>=layout.shape[0]||tz>=layout.shape[1])return null;
  return layout.tiles.find(t=>t.key===tz*layout.shape[0]+tx)??null;
}

                                                                           
                                                                      
export function fitShoreTiles(terrain,sea,hs,maxLayers,coast=null){
  if(!Number.isInteger(maxLayers)||maxLayers<3)throw Error('At least three shore array layers required');
  let metres=32,layout;
  for(let attempt=0;attempt<20;attempt++,metres*=2){
    layout=buildShoreTiles(terrain,sea,hs,metres,128,2,coast);
    if(Math.max(1,layout.tiles.length)*3<=maxLayers)return {...layout,capacityLayers:maxLayers,resolutionAdapted:metres!==32};
  }
  throw Error('Cannot fit fixed shoreline pages to GPU capacity');
}
