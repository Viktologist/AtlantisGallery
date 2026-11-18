                                                                         
                                                                              
export function selectSurfacePatches(shape,spacing,eye,range,focal,{minWidth=8,pixelStep=6}={}){
 const [nz,nx]=shape,[dx,dz]=spacing;let splits=0;
 const size=Math.max(64,2**Math.ceil(Math.log2(Math.max(nx,nz)-1)));
 const root={x:0,z:0,w:size};
 function split(n){const h=n.w/2;n.children=[[0,0],[h,0],[0,h],[h,h]].map(([x,z])=>({x:n.x+x,z:n.z+z,w:h}));splits++;}
 function choose(n){
  if(n.x>=nx-1||n.z>=nz-1){n.out=true;return;}
  const x0=n.x*dx,z0=n.z*dz,x1=Math.min(n.x+n.w,nx-1)*dx,z1=Math.min(n.z+n.w,nz-1)*dz;
  const distance=Math.max(Math.min(dx,dz)*.125,Math.hypot(Math.max(x0-eye[0],0,eye[0]-x1),Math.max(range[0]-eye[1],0,eye[1]-range[1]),Math.max(z0-eye[2],0,eye[2]-z1)));
  if(n.w>minWidth&&n.w*Math.max(dx,dz)/64*focal/distance>pixelStep){split(n);n.children.forEach(choose);}
 }
 choose(root);
 function leaves(n=root,out=[]){if(n.out)return out;if(n.children)n.children.forEach(c=>leaves(c,out));else out.push(n);return out;}
 function at(x,z){if(x<0||z<0||x>=nx-1||z>=nz-1)return null;let n=root;while(n.children){const h=n.w/2;n=n.children[(x>=n.x+h?1:0)+(z>=n.z+h?2:0)];}return n.out?null:n;}
 const neighbors=n=>{const mx=(n.x+Math.min(n.x+n.w,nx-1))/2,mz=(n.z+Math.min(n.z+n.w,nz-1))/2;return [[n.x-1e-4,mz],[n.x+n.w+1e-4,mz],[mx,n.z-1e-4],[mx,n.z+n.w+1e-4]].map(([x,z])=>at(x,z));};
                                                          
 for(let pass=0;pass<20;pass++){
  const todo=new Set();for(const n of leaves())for(const neighbor of neighbors(n))if(neighbor&&neighbor.w>n.w*2)todo.add(neighbor);
  if(!todo.size)break;for(const n of todo){split(n);for(const c of n.children)if(c.x>=nx-1||c.z>=nz-1)c.out=true;}
  if(pass===19)throw Error('Surface LOD balancing did not converge');
 }
 const list=leaves(),patches=[],seams=[];let stitchedEdges=0,maxRatio=1;
 for(const n of list){patches.push([n.x,n.z,n.w,0]);seams.push(neighbors(n).map(other=>{if(other)maxRatio=Math.max(maxRatio,other.w/n.w);if(other&&other.w>n.w){stitchedEdges++;return other.w/64;}return 0;}));}
 return {patches,seams,metadata:{patches:list.length,splits,stitched_edges:stitchedEdges,max_neighbor_ratio:maxRatio,min_grid_step:list.reduce((v,n)=>Math.min(v,n.w/64),Infinity),max_grid_step:list.reduce((v,n)=>Math.max(v,n.w/64),0),triangles:list.length*8192,selector:'CPU balanced quadtree, projected grid spacing target',morphing:false}};
}
