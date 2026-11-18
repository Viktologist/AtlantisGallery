import {Matrix4} from '../../vendor/tidewater/src/engine/index.js';
import {floatAttribute} from './mesh_gltf.js';
                                                                                 
export function initialPrimitivePose(parsed,primitive,nodeIndex,groups) {
  const node=parsed.json.nodes[nodeIndex],mesh=parsed.json.meshes[node.mesh];
  if(node.skin===undefined&&!primitive.targets.length)return primitive;
  const attributes={...primitive.attributes};
  for(const key of ['POSITION','NORMAL','TANGENT','COLOR_0'])if(attributes[key])attributes[key]={...attributes[key],array:floatAttribute(attributes[key]).slice(),componentType:5126,normalized:false};
  const weights=node.weights??mesh.weights??[];
  if(weights.length>primitive.targets.length||!weights.every(Number.isFinite))throw Error('Invalid initial morph weights');
  primitive.targets.forEach((target,i)=>{
    for(const [key,a] of Object.entries(target)) {
      if(!['POSITION','NORMAL','COLOR_0'].includes(key))throw Error(`Unsupported initial morph semantic ${key}`);
      const dst=attributes[key],delta=floatAttribute(a);
      if(!dst||dst.itemSize!==a.itemSize||dst.array.length!==delta.length||!delta.every(Number.isFinite))throw Error('Invalid morph shape/values');
      for(let c=0;c<delta.length;c++)dst.array[c]+=delta[c]*(weights[i]??0);
    }
  });
  if(node.skin!==undefined) {
    const skin=parsed.json.skins?.[node.skin],joints=attributes.JOINTS_0,wa=attributes.WEIGHTS_0;
    if(!skin?.joints?.length||!joints||!wa||joints.itemSize!==4||wa.itemSize!==4||joints.array.length/4!==attributes.POSITION.array.length/3||wa.array.length!==joints.array.length)throw Error('Invalid initial skin attributes');
    const inverse=skin.inverseBindMatrices===undefined?null:parsed.readAccessor(skin.inverseBindMatrices);
    if(inverse&&(inverse.itemSize!==16||inverse.array.length!==skin.joints.length*16))throw Error('Invalid inverse bind matrices');
    const invWorld=groups[nodeIndex].matrixWorld.clone().invert();
    const bones=skin.joints.map((j,i)=>{
      if(!Number.isInteger(j)||!groups[j])throw Error('Invalid skin joint');
      const ibm=inverse?new Matrix4().fromArray(floatAttribute(inverse),i*16):new Matrix4();
      const m=invWorld.clone().multiply(groups[j].matrixWorld).multiply(ibm);
      if(!m.elements.every(Number.isFinite))throw Error('Nonfinite initial skin matrix');return m.elements;
    });
    const w=floatAttribute(wa);
    for(let v=0;v<w.length/4;v++) {
                                                                          
      const sum=Math.abs(w[v*4])+Math.abs(w[v*4+1])+Math.abs(w[v*4+2])+Math.abs(w[v*4+3]);
      const blend=new Float64Array(16);
      for(let c=0;c<4;c++) {
        const weight=sum?w[v*4+c]/sum:(c===0?1:0),j=joints.array[v*4+c];
        if(!Number.isInteger(j)||!bones[j]||!Number.isFinite(weight))throw Error('Invalid joint/weight');
        for(let k=0;k<16;k++)blend[k]+=weight*bones[j][k];
      }
      for(const key of ['POSITION','NORMAL','TANGENT'])if(attributes[key]) {
        const a=attributes[key],o=v*a.itemSize,x=a.array[o],y=a.array[o+1],z=a.array[o+2],h=key==='POSITION'?1:0;
        for(let c=0;c<3;c++)a.array[o+c]=blend[c]*x+blend[4+c]*y+blend[8+c]*z+blend[12+c]*h;
      }
    }
  }
  return {...primitive,attributes,initialPose:true};
}
