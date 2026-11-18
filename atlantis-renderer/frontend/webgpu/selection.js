import {Ray,Vector3,Matrix4} from '../../vendor/tidewater/src/engine/index.js';

                                                                              
                                                                             
export function pickAtPixel(viewer,x,y){
 if(viewer.disposed||!viewer.root)return null;
 const rect=viewer.canvas.getBoundingClientRect(),u=(x-rect.left)/rect.width,v=(y-rect.top)/rect.height;
 if(u<0||u>1||v<0||v>1)return null;
 viewer.camera.updateMatrixWorld();
 const eye=viewer.camera.position.clone(),ray=new Ray(eye,new Vector3(u*2-1,1-v*2,.5).unproject(viewer.camera).sub(eye).normalize());
 let best=null,distance=Infinity;
 viewer.root.updateMatrixWorld(true);
 viewer.root.traverse(mesh=>{
  if(!mesh.isMesh||!mesh.visible)return;
  for(let parent=mesh.parent;parent;parent=parent.parent)if(!parent.visible)return;
  const wire=mesh.userData.apsWire,geometry=wire?.original??mesh.geometry,material=wire?.originalMaterial??mesh.material,pos=geometry.attributes.position,indices=geometry.index?.array,topology=material.topology??'triangle-list';
  if(!pos)return;
  const instances=mesh.isInstancedMesh?mesh.count:1;
  for(let instance=0;instance<instances;instance++){
   const world=mesh.matrixWorld.clone();if(mesh.isInstancedMesh)world.multiply(new Matrix4().fromArray(mesh.instanceMatrix.array,instance*16));
   const localRay=ray.clone().applyMatrix4(world.clone().invert());
   const start=geometry.drawRange?.start??0,end=Math.min(indices?.length??pos.count,start+(geometry.drawRange?.count??Infinity)),p=new Vector3(),a=new Vector3(),b=new Vector3(),c=new Vector3();
   const read=(out,i)=>out.fromBufferAttribute(pos,indices?indices[i]:i);
   const accept=(point,index,kind)=>{const d=eye.distanceTo(point);if(d<distance){distance=d;best={mesh,object:mesh.name,entity_id:mesh.userData.instance_entity_ids?.[instance]||mesh.userData.entity_id||mesh.name||'未命名部件',instance:mesh.isInstancedMesh?instance:null,source_instance:mesh.userData.sourceInstanceIndices?.[instance]??null,primitive:index,primitive_kind:kind,triangle:kind==='triangle'?index:null,point:point.toArray(),distance_m:d,source:'native_cpu_raycast'};}};
   if(topology==='point-list'){
    for(let i=start;i<end;i++){read(a,i).applyMatrix4(world);if(ray.distanceSqToPoint(a)<1){ray.closestPointToPoint(a,p);accept(p,i-start,'point');}}
   }else if(topology==='line-list'||topology==='line-strip'){
    const step=topology==='line-list'?2:1;
    for(let i=start;i+1<end;i+=step){read(a,i).applyMatrix4(world);read(b,i+1).applyMatrix4(world);const q=closestRaySegment(ray,a,b);if(q.errorSquared<=1)accept(q.point,Math.floor((i-start)/step),'line');}
   }else if(topology==='triangle-list'){
    if(!geometry.boundingBox)geometry.computeBoundingBox();if(!localRay.intersectsBox(geometry.boundingBox))continue;
    for(let i=start;i+2<end;i+=3){read(a,i);read(b,i+1);read(c,i+2);const found=material.side==='back'?localRay.intersectTriangle(c,b,a,true,p):localRay.intersectTriangle(a,b,c,material.side!=='double',p);if(found)accept(p.applyMatrix4(world),(i-start)/3,'triangle');}
   }
  }
 });
 return best;
}

export async function selectAtPixel(viewer,x,y){
 const hit=pickAtPixel(viewer,x,y);if(!hit)return null;
 const {mesh,...best}=hit;viewer.selection=best;viewer.onSelect(best.entity_id);return best;
}

                                                                               
export function closestRaySegment(ray,a,b){
 const segment=b.clone().sub(a),w=ray.origin.clone().sub(a),dd=segment.lengthSq(),bd=ray.direction.dot(segment),dw=ray.direction.dot(w),sw=segment.dot(w),denom=dd-bd*bd;
 const candidates=[];
 const add=(t,s)=>{const point=a.clone().addScaledVector(segment,s),onRay=ray.origin.clone().addScaledVector(ray.direction,t);candidates.push({point,errorSquared:point.distanceToSquared(onRay)});};
 if(dd===0){add(Math.max(0,-dw),0);}else{
  add(Math.max(0,-dw),0);add(Math.max(0,bd-dw),1);add(0,Math.max(0,Math.min(1,sw/dd)));
  if(denom>1e-12){const t=(bd*sw-dd*dw)/denom,s=(sw+bd*t)/dd;if(t>=0&&s>=0&&s<=1)add(t,s);}
 }
 return candidates.reduce((a,b)=>a.errorSquared<b.errorSquared?a:b);
}
