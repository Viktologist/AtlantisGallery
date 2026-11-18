                                                                           
                                                                              
                                                                              
                                                                
  
                                                                          
                                                                           
                    
const MAX_ID_CHARS = 128;
const CONTROL = /[\u0000-\u001f\u007f]/;

export function createAssetRegistry() {
	return new Map();
}

export function normalizeAssetId(id) {
	if(typeof id!=='string'||!id.trim())throw Error('Asset id must be a nonempty string');
	const value=id.trim();
	if(value.length>MAX_ID_CHARS)throw Error('Asset id is longer than '+MAX_ID_CHARS+' characters');
	if(CONTROL.test(value))throw Error('Asset id contains control characters');
	return value;
}

                                                                              
                                                                              
                                                                              
                                
export function registerAsset(registry,id,{root=null,api=null,kind='glb',url=null,tagRoot=true}={}) {
	const key=normalizeAssetId(id);
	const record={id:key,root:root??api?.root??null,api,kind,url,visible:null};
	if(record.root&&tagRoot!==false){
		record.root.userData??={};
		record.root.userData.apsSceneAssetId=key;
	}
	registry.set(key,record);
	return record;
}

export function assetRecord(registry,id) {
	return registry instanceof Map?registry.get(id)??null:null;
}

export function assetIds(registry) {
	return registry instanceof Map?[...registry.keys()]:[];
}

                                                                     
export function setAssetVisible(registry,id,visible) {
	const record=assetRecord(registry,typeof id==='string'?id.trim():id);
	if(!record)throw Error('Unknown scene asset: '+String(id));
	const shown=visible===true;
	if(record.root)record.root.visible=shown;
	record.visible=shown;
	return shown;
}

                                                                           
                                                                         
                                        
export function showOnlyAsset(registry,id) {
	const record=assetRecord(registry,typeof id==='string'?id.trim():id);
	if(!record||!record.root)return {ok:false,reason:'asset-not-loaded',available:assetIds(registry)};
	let shown=0;
	for(const entry of registry.values()){
		const visible=entry===record;
		if(entry.root)entry.root.visible=visible;
		entry.visible=visible;
		if(visible&&entry.root)shown++;
	}
	return {ok:shown===1,reason:shown===1?null:'asset-root-unavailable',asset_id:record.id,available:assetIds(registry)};
}

                                                                              
                                                   
export function visibleAssetIds(registry) {
	const ids=[];
	for(const entry of registry instanceof Map?registry.values():[])if(entry.root&&entry.root.visible===true)ids.push(entry.id);
	return ids;
}

export function assetState(registry,id) {
	const record=assetRecord(registry,typeof id==='string'?id.trim():id);
	if(!record)return null;
	return {
		id:record.id,
		kind:record.kind,
		url:record.url,
		visible:!!(record.root&&record.root.visible===true),
		root_present:!!record.root
	};
}

export function assetStates(registry) {
	const rows=[];
	for(const entry of registry instanceof Map?registry.values():[])rows.push(assetState(registry,entry.id));
	return rows;
}
