                                                                               
export function normalizeEnvironmentYaw(degrees){
 if(!Number.isFinite(degrees))throw new RangeError('Environment yaw must be finite degrees');
 const angle=((degrees%360)+360)%360;return Object.is(angle,-0)?0:angle;
}
export function rotateEnvironmentVector(vector,degrees){
 const angle=normalizeEnvironmentYaw(degrees)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
 return [c*vector[0]+s*vector[2],vector[1],-s*vector[0]+c*vector[2]];
}
