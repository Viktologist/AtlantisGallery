                                                                               
export function grassWorldHash(value){let h=value>>>0;h^=h>>>16;h=Math.imul(h,2246822519);h^=h>>>13;h=Math.imul(h,3266489917);h^=h>>>16;return (h>>>8)/16777216;}
export function grassWorldLayout(region,step){
 if(!(Number.isFinite(step)&&step>0))throw Error('Invalid world grass cell size');
 step=Math.fround(step);
 const min=region.min.map(x=>Math.floor(x/step)-1),max=region.min.map((x,i)=>Math.ceil((x+region.extent[i])/step)+1);
 const shape=max.map((x,i)=>x-min[i]);
 if(shape.some(x=>x<1)||shape[0]*shape[1]>0xfffffffe)throw Error('World grass identity grid exceeds uint32 range');
 return {step,min,shape};
}
export function grassWorldAnchor(x,z,step,seed){
 const cell=[Math.floor(x/step),Math.floor(z/step)],h=(Math.imul(cell[0],1597334677)^Math.imul(cell[1],3812015801)^seed)>>>0;
 return {cell,seed:h,position:[(cell[0]+grassWorldHash(h+1))*step,(cell[1]+grassWorldHash(h+2))*step],yaw:grassWorldHash(h+7)*Math.PI*2,normal_jitter:[(grassWorldHash(h+8)-.5)*.08,(grassWorldHash(h+9)-.5)*.08]};
}
