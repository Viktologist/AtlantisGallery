import {Matrix4,Vector3,Vector4,Matrix3,Box3} from '../../vendor/tidewater/src/engine/index.js';

export function mirrorPlaneGeometry(geometry,options={}){
 const p=geometry.attributes.position,index=geometry.index;
 if(!p||p.itemSize!==3)throw Error('Planar mirror requires position triangles');
 const ids=index?.array??Array.from({length:p.count},(_,i)=>i),triangles=[];
 for(let i=0;i+2<ids.length;i+=3){const t=[0,1,2].map(k=>new Vector3().fromBufferAttribute(p,ids[i+k]));if(new Vector3().subVectors(t[1],t[0]).cross(new Vector3().subVectors(t[2],t[0])).lengthSq()>1e-16)triangles.push(t);}
 const first=triangles.find(([a,b,c])=>new Vector3().subVectors(b,a).cross(new Vector3().subVectors(c,a)).lengthSq()>1e-16);
 if(!first)throw Error('Mirror has no nondegenerate triangles');
 const point=options.point?new Vector3().fromArray(options.point):first[0].clone();
 const normal=options.normal?new Vector3().fromArray(options.normal):new Vector3().subVectors(first[1],first[0]).cross(new Vector3().subVectors(first[2],first[0]));
 if(![...point.toArray(),...normal.toArray()].every(Number.isFinite)||normal.lengthSq()<1e-16)throw Error('Invalid mirror plane');normal.normalize();
 geometry.computeBoundingBox();const size=geometry.boundingBox.getSize(new Vector3()).length(),tolerance=options.tolerance??Math.max(1e-5,size*1e-5);
 if(!(tolerance>=0&&Number.isFinite(tolerance))||triangles.some(t=>t.some(v=>Math.abs(normal.dot(v.clone().sub(point)))>tolerance)))throw Error('Marked mirror geometry is not planar; mark the actual reflective primitive');
 return {point,normal,triangles};
}
export function transformMirrorPlane(local,matrix){
 const point=local.point.clone().applyMatrix4(matrix),normal=local.normal.clone().applyMatrix3(new Matrix3().getNormalMatrix(matrix)).normalize();
 return {point,normal,constant:-normal.dot(point)};
}
export function reflectionMatrix({normal:n,constant:d}){
 const {x,y,z}=n;return new Matrix4().set(1-2*x*x,-2*x*y,-2*x*z,-2*d*x,-2*y*x,1-2*y*y,-2*y*z,-2*d*y,-2*z*x,-2*z*y,1-2*z*z,-2*d*z,0,0,0,1);
}
                                                                 
                                                                        
export function obliqueMirrorProjection(base,worldMatrix,plane,clipBias=.002){
 const p=new Vector4(plane.normal.x,plane.normal.y,plane.normal.z,plane.constant-clipBias).applyMatrix4(worldMatrix.clone().transpose());
 const q=new Vector4(Math.sign(p.x)||1,Math.sign(p.y)||1,0,1).applyMatrix4(base.clone().invert()),dot=p.dot(q);
 if(!Number.isFinite(dot)||dot<=1e-9)throw Error('Degenerate mirror oblique projection');
 const e=base.clone(),m=e.elements,c=p.multiplyScalar(1/dot);m[2]=m[3]-c.x;m[6]=m[7]-c.y;m[10]=m[11]-c.z;m[14]=m[15]-c.w;return e;
}
                                                                             
export function triangleDistanceSq(p,a,b,c){
 const ab=b.clone().sub(a),ac=c.clone().sub(a),ap=p.clone().sub(a),d1=ab.dot(ap),d2=ac.dot(ap);
 if(d1<=0&&d2<=0)return ap.lengthSq();
 const bp=p.clone().sub(b),d3=ab.dot(bp),d4=ac.dot(bp);if(d3>=0&&d4<=d3)return bp.lengthSq();
 const vc=d1*d4-d3*d2;if(vc<=0&&d1>=0&&d3<=0)return p.distanceToSquared(a.clone().addScaledVector(ab,d1/(d1-d3)));
 const cp=p.clone().sub(c),d5=ab.dot(cp),d6=ac.dot(cp);if(d6>=0&&d5<=d6)return cp.lengthSq();
 const vb=d5*d2-d1*d6;if(vb<=0&&d2>=0&&d6<=0)return p.distanceToSquared(a.clone().addScaledVector(ac,d2/(d2-d6)));
 const va=d3*d6-d5*d4;if(va<=0&&(d4-d3)>=0&&(d5-d6)>=0)return p.distanceToSquared(b.clone().addScaledVector(c.clone().sub(b),(d4-d3)/((d4-d3)+(d5-d6))));
 const s=va+vb+vc;if(Math.abs(s)<1e-20)return Math.min(p.distanceToSquared(a),p.distanceToSquared(b),p.distanceToSquared(c));
 return p.distanceToSquared(a.clone().addScaledVector(ab,vb/s).addScaledVector(ac,vc/s));
}
export function mirrorSurface(local,matrix,eye){
 const triangles=local.triangles.map(t=>t.map(v=>v.clone().applyMatrix4(matrix))),box=new Box3().makeEmpty();let distanceSq=Infinity;
 for(const [a,b,c]of triangles){box.expandByPoint(a);box.expandByPoint(b);box.expandByPoint(c);distanceSq=Math.min(distanceSq,triangleDistanceSq(eye,a,b,c));}
 return {plane:transformMirrorPlane(local,matrix),distanceSq,box};
}
