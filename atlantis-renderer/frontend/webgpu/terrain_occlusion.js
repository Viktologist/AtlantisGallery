                                                                                
                                                                                
import {GPU,ShaderModule,UniformBlock,Texture} from '../../vendor/tidewater/src/engine/webgpu.js';
import {
  TERRAIN_RAY_TILE_CELLS,buildTerrainRayQuery,terrainOcclusionWGSL,
  terrainRaySourceKey,terrainQueryMetadata,
} from './terrain_ray_query.js';

export class TerrainOcclusion {
  constructor(viewer){
    this.viewer=viewer;this.terrain=null;this.terrainKey=null;this.terrainRevision=0;
    this.params=new UniformBlock('APSTerrainRayParams',{
      originSpacing:['vec4f',[0,0,1,1]],
      shapeTile:['vec4u',[0,0,TERRAIN_RAY_TILE_CELLS,0]],
      maxShapeRevision:['vec4u',[0,0,0,0]],
    });
    this.emptyHeight=new Texture({label:'Empty terrain query height',width:1,height:1,format:'r32float',data:new Float32Array(1)});
    this.emptyMax=new Texture({label:'Empty terrain query bounds',width:1,height:1,format:'r32float',data:new Float32Array(1)});
    this.module=new ShaderModule({name:'apsTerrainOcclusion',bindings:{
      apsTerrainP:{uniform:this.params},
      apsTerrainHeight:{texture:()=>this.terrain?.heightTexture??this.emptyHeight,sampleType:'unfilterable-float'},
      apsTerrainMax:{texture:()=>this.terrain?.maxTexture??this.emptyMax,sampleType:'unfilterable-float'},
    },code:terrainOcclusionWGSL});
  }
  ensureTerrain(){
    if(this.disposed)return false;
    const terrain=this.viewer.heightfield,intervention=this.viewer.terrainIntervention??null;
    if(!terrain?.heightTexture||!terrain.native){this.disableTerrain();return false;}
    const native=terrain.native,key=terrainRaySourceKey(native,terrain.heightTexture.id,intervention);
    if(key===this.terrainKey)return true;
    const query=buildTerrainRayQuery(native,{targetHeight:intervention?.targetHeight??null,tileCells:TERRAIN_RAY_TILE_CELLS});
    const maxTexture=new Texture({label:'Terrain query conservative tile bounds',width:query.maxWidth,height:query.maxHeight,format:'r32float',data:query.maxData});
    maxTexture.getGPU();const prior=this.terrain?.maxTexture;
    this.terrain={heightTexture:terrain.heightTexture,maxTexture,query};this.terrainKey=key;this.terrainRevision++;
    this.params.set('originSpacing',[native.origin[0],native.origin[1],native.spacing[0],native.spacing[1]]);
    this.params.set('shapeTile',[query.shape[1],query.shape[0],query.tileCells,1]);
    this.params.set('maxShapeRevision',[query.maxWidth,query.maxHeight,this.terrainRevision,0]);
    if(prior)GPU.onSubmit(null,()=>prior.destroy());
    return true;
  }
  disableTerrain(){
    if(!this.terrain&&this.terrainKey===null)return;
    const prior=this.terrain?.maxTexture;this.terrain=null;this.terrainKey=null;this.terrainRevision++;
    this.params.set('shapeTile',[0,0,TERRAIN_RAY_TILE_CELLS,0]);
    this.params.set('maxShapeRevision',[0,0,this.terrainRevision,0]);
    if(prior)GPU.onSubmit(null,()=>prior.destroy());
  }
  metadata(){
    const {legacy_result,composition,...terrain}=terrainQueryMetadata(this.terrain?.query,this.viewer.terrainIntervention);
    return {...terrain,revision:this.terrainRevision,composition:'independent live terrain ray query; building occlusion uses compiled LPV link/solid-cell DDA',building_bsp:false};
  }
  dispose(){
    if(this.disposed)return;this.disableTerrain();this.disposed=true;
    this.emptyHeight.destroy();this.emptyMax.destroy();this.params.buffer?.destroy();
  }
}
