                                                                            
                                                                                   
export function projectBounds(vp,center,extent,width,height){
  const clips=[];
  for(let i=0;i<8;i++){
    const p=center.map((c,k)=>c+((i>>k)&1?1:-1)*extent[k]);
    clips.push([0,1,2,3].map(r=>vp[r]*p[0]+vp[4+r]*p[1]+vp[8+r]*p[2]+vp[12+r]));
  }
  const outside=[c=>c[0]<-c[3],c=>c[0]>c[3],c=>c[1]<-c[3],c=>c[1]>c[3],c=>c[2]<0,c=>c[2]>c[3]].some(f=>clips.every(f));
  const protectedNear=clips.some(c=>c[3]<=1e-6||c[2]<0||c[2]>c[3]);
  if(protectedNear)return {outside,protectedNear,pixels:Infinity};
  const points=clips.map(c=>[(c[0]/c[3]*.5+.5)*width,(.5-c[1]/c[3]*.5)*height,c[2]/c[3]]);
  const lo=[0,1,2].map(k=>Math.min(...points.map(c=>c[k]))),hi=[0,1,2].map(k=>Math.max(...points.map(c=>c[k])));
  return {outside,protectedNear,lo,hi,pixels:Math.max(hi[0]-lo[0],hi[1]-lo[1])};
}
export function chooseLOD(pixels,previous=3,thresholds=[200,55],residentMask=7,enabled=true){
  if(!(residentMask&7))throw Error('At least one actual geometry LOD must be resident');
  let lod=enabled?(pixels>=thresholds[0]?0:pixels>=thresholds[1]?1:2):0;
  if(enabled&&previous<3&&previous!==lod){
    if(lod>previous&&pixels>thresholds[previous]*.8)lod=previous;
    if(lod<previous&&pixels<thresholds[lod]*1.2)lod=previous;
  }
  for(let k=lod;k<3;k++)if(residentMask&(1<<k))return k;
  for(let k=lod-1;k>=0;k--)if(residentMask&(1<<k))return k;
}
export function visibleDepthRect(projected,width,height){
  if(projected.protectedNear||!projected.lo||!projected.hi||projected.hi[0]<0||projected.hi[1]<0||projected.lo[0]>=width||projected.lo[1]>=height)return null;
  return {lo:projected.lo.slice(0,2).map((v,i)=>Math.max(0,Math.min(v,[width,height][i]-.001))),hi:projected.hi.slice(0,2).map((v,i)=>Math.max(0,Math.min(v,[width,height][i]-.001)))};
}
export function occludedByDepth(projected,furthestDepth,reversed=true,bias=null,near=.1,metres=.02,far=Infinity){
  if(projected.protectedNear||projected.outside||!projected.lo)return false;
  bias??=reversed?metricDepthBias(Math.max(Math.abs(furthestDepth),Math.abs(projected.hi[2])),near,metres,far):2e-5;
  return reversed?projected.hi[2]<furthestDepth-bias:projected.lo[2]>furthestDepth+bias;
}
export function metricDepthBias(nearest,near,metres=.02,far=Infinity){
  if(!(near>0)||!(far>near)||!Number.isFinite(metres)||metres<0)throw Error('Metric depth tolerance requires valid camera planes and nonnegative metres');
  const offset=Number.isFinite(far)?near/(far-near):0,d=nearest+offset;
  return d*d*metres/(near*(1+offset))+d*9.536743e-7;
}
