                                                                           
                                                                            
                                                                     
  
                                                                               
                                                                                
                                                                
import {ArticulatedAsset} from './articulation_controls.js';

const SCHEMA = 'APS_articulation/1';

export function createPoseRegistry() {
	return new Map();
}

function assetKey(id) {
	if(typeof id!=='string'||!id.trim())throw Error('Asset id must be a nonempty string');
	return id.trim();
}

                                                                            
                                                                      
export function assetPoseModel(registry,id,resolve) {
	const key=assetKey(id);
	if(registry.has(key))return registry.get(key);
	const record=typeof resolve==='function'?resolve(key):null;
	if(!record)throw Error('Unknown scene asset: '+String(id));
	const asset=record.api??record;
	const contract=asset?.sceneData?.extras?.APS_articulation;
	const root=record.root??asset?.root??null;
	let model=null;
	if(contract?.schema===SCHEMA&&root&&Array.isArray(contract.joints)&&contract.joints.length){
		for(const joint of contract.joints){
			                                                                           
			                                                               
			if(!Array.isArray(joint?.dofs)||!(joint.type==='fixed'&&joint.dofs.length===0)&&joint.dofs.length!==1)throw Error('Joint '+String(joint?.name)+' has '+String(joint?.dofs?.length)+' DOFs; one named DOF per joint is required except fixed zero-DOF joints');
		}
		model=new ArticulatedAsset({root,sceneData:asset.sceneData});
	}
	registry.set(key,model);
	return model;
}

function jointLimits(row) {
	const limits=row?.dof?.limits;
	return Array.isArray(limits)&&limits.length===2?limits:null;
}

export function clampJointValue(limits,value) {
	if(!Array.isArray(limits))return value;
	let out=value;
	const [lo,hi]=limits;
	if(typeof lo==='number'&&Number.isFinite(lo)&&out<lo)out=lo;
	if(typeof hi==='number'&&Number.isFinite(hi)&&out>hi)out=hi;
	return out;
}

                                                                                
                                                                  
export function normalizePoseStates(joints) {
	let rows;
	if(Array.isArray(joints))rows=joints;
	else if(joints&&typeof joints==='object')rows=Object.entries(joints).map(([joint,value])=>({joint,value}));
	else throw Error('Asset pose must be an array of {joint,value} entries or an object of joint to value');
	if(!rows.length)throw Error('Asset pose names no joint values');
	return rows.map((row,index)=>{
		const joint=row?.joint??row?.name;
		const value=row?.value;
		if(typeof joint!=='string'||!joint.trim())throw Error('Pose entry '+index+' needs a nonempty joint name');
		if(typeof value!=='number'||!Number.isFinite(value))throw Error('Pose joint '+joint+' needs a finite number');
		return {joint:joint.trim(),value};
	});
}

function jointValues(model) {
	const values={};
	for(const [name,row] of model.joints)values[name]=model.values.has(name)?model.values.get(name):row.dof.reference;
	return values;
}

                                                                              
                                                                            
                                                                           
                
export function applyAssetPose(registry,id,joints,resolve) {
	const model=assetPoseModel(registry,id,resolve);
	const key=assetKey(id);
	if(joints===null||joints===undefined){
		if(!model)return {asset_id:key,articulated:false,reset:false,applied:{},joints:{}};
		for(const [name,row] of model.joints)model.set(name,row.dof.reference,{immediate:true});
		model.asset.root?.updateMatrixWorld?.(true);
		return {asset_id:key,articulated:true,reset:true,applied:{},joints:jointValues(model)};
	}
	if(!model)throw Error('Scene asset has no exported articulation contract: '+key);
	const states=normalizePoseStates(joints);
	const applied={};
	const clamped={};
	for(const {joint,value} of states){
		const row=model.joints.get(joint);
		if(!row)throw Error('Unknown joint for asset '+key+': '+joint);
		const next=clampJointValue(jointLimits(row),value);
		if(next!==value)clamped[joint]=next;
		model.set(joint,next,{immediate:true});
		applied[joint]=next;
	}
	model.asset.root?.updateMatrixWorld?.(true);
	const result={asset_id:key,articulated:true,reset:false,applied,joints:jointValues(model)};
	if(Object.keys(clamped).length)result.clamped=clamped;
	return result;
}

                                                                
export function assetPose(registry,id,resolve) {
	const model=assetPoseModel(registry,id,resolve);
	const key=assetKey(id);
	if(!model)return {asset_id:key,articulated:false,joints:{},limits:{},reference:{}};
	const joints=jointValues(model),limits={},reference={};
	for(const [name,row] of model.joints){
		limits[name]=jointLimits(row);
		reference[name]=row.dof.reference;
	}
	return {asset_id:key,articulated:true,joints,limits,reference};
}
