                                                                             
export function wheelPixels(delta,mode=0,height=800){
  if(!Number.isFinite(delta))return 0;
  return Math.max(-240,Math.min(240,delta*(mode===1?16:mode===2?height:1)));
}
export function wheelFraction(delta,distance,near=.01){
  if(!(distance>0)||!Number.isFinite(distance))return 0;
  const fraction=1-Math.exp(delta*.0012);
  return fraction>0?Math.min(fraction,Math.max(0,1-Math.max(.0001,near*1.5)/distance)):fraction;
}
export function panMetresPerPixel(depth,fovDegrees,height){
  if(!(depth>0)||!(height>0)||!(fovDegrees>0&&fovDegrees<180))return 0;
  return 2*depth*Math.tan(fovDegrees*Math.PI/360)/height;
}
