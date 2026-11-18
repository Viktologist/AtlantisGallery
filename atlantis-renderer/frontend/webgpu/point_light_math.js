                                                                             
export const POINT_FACES=[[[1,0,0],[0,-1,0]],[[-1,0,0],[0,-1,0]],[[0,1,0],[0,0,1]],[[0,-1,0],[0,0,-1]],[[0,0,1],[0,-1,0]],[[0,0,-1],[0,-1,0]]];
export function sphereIntersectsBox(position,radius,box){
 if(!box)return true;
 const lo=box.min.toArray?.()??box.min,hi=box.max.toArray?.()??box.max;
 let d=0;for(let k=0;k<3;k++)d+=Math.max(lo[k]-position[k],0,position[k]-hi[k])**2;
 return d<=radius*radius;
}
export function boxIntersectsClip(box,matrix){
 if(!box)return true;
 const m=matrix.elements??matrix,lo=box.min.toArray?.()??box.min,hi=box.max.toArray?.()??box.max;
 const c=lo.map((v,k)=>(v+hi[k])/2),h=lo.map((v,k)=>(hi[k]-v)/2);
                                                           
                                                                          
 const rows=[0,1,2,3].map(r=>[m[r],m[r+4],m[r+8],m[r+12]]);
 const planes=[...rows.slice(0,2).flatMap(r=>[r.map((v,k)=>rows[3][k]+v),r.map((v,k)=>rows[3][k]-v)]),rows[2],rows[3].map((v,k)=>v-rows[2][k])];
 return planes.every(p=>p[0]*c[0]+p[1]*c[1]+p[2]*c[2]+p[3]+Math.abs(p[0])*h[0]+Math.abs(p[1])*h[1]+Math.abs(p[2])*h[2]>=-1e-6);
}

                                                                                 
                                                                                
export function buildLightGrid(lights,size=16){
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];let always=0;
 lights.forEach((l,i)=>{const r=l.distance??l.range??0;if(r<=0){always=(always|(1<<i))>>>0;return;}for(let k=0;k<3;k++){min[k]=Math.min(min[k],l.position[k]-r);max[k]=Math.max(max[k],l.position[k]+r);}});
 if(!Number.isFinite(min[0])){min.fill(0);max.fill(1);}
 const cell=min.map((v,k)=>Math.max((max[k]-v)/size,1e-5)),masks=new Uint32Array(size**3).fill(always);
 lights.forEach((l,i)=>{const r=l.distance??l.range??0;if(r<=0)return;const p=l.position;
 const a=p.map((v,k)=>Math.max(0,Math.floor((v-r-min[k])/cell[k]))),b=p.map((v,k)=>Math.min(size-1,Math.floor((v+r-min[k])/cell[k])));
 for(let z=a[2];z<=b[2];z++)for(let y=a[1];y<=b[1];y++)for(let x=a[0];x<=b[0];x++){
 const low=[x,y,z].map((v,k)=>min[k]+v*cell[k]),high=low.map((v,k)=>v+cell[k]);
 if(sphereIntersectsBox(p,r,{min:low,max:high})){const j=x+size*(y+size*z);masks[j]=(masks[j]|(1<<i))>>>0;}
 }});
 return {min,cell,size,always,masks};
}
