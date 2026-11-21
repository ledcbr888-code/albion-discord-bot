'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');

function validateTracking(bytes){
    const value=JSON.parse(String(bytes));
    if(!value||value.version!==3||!value.guilds||typeof value.guilds!=='object'||Array.isArray(value.guilds))
        throw Error('Tracking snapshot is not valid v3 state');
    return value;
}

// Keep exactly one pre-switch snapshot in the existing persistent tracking
// directory; do not add an upload, database table, or automatic restore.
function backupTrackingFile(trackingPath,{io=fs,paths=path,uuid=randomUUID}={}){
    const source=io.readFileSync(trackingPath);
    validateTracking(source);
    const folder=paths.join(paths.dirname(trackingPath),'.bossbot-backups');
    const target=paths.join(folder,'tracking-before-zvz-v1.json');
    io.mkdirSync(folder,{recursive:true,mode:0o700});
    const verifyExisting=()=>{
        if(!io.lstatSync(target).isFile())throw Error('Existing backup is not a regular file');
        validateTracking(io.readFileSync(target));
        return {created:false,path:target};
    };
    if(io.existsSync(target))return verifyExisting();
    const temporary=paths.join(folder,'tracking-'+uuid()+'.tmp');
    try{
        io.writeFileSync(temporary,source,{mode:0o600,flag:'wx'});
        validateTracking(io.readFileSync(temporary));
        // Atomic, non-overwriting publication. Any other error fails closed:
        // the optional source stays disabled while the original bot can run.
        try{io.linkSync(temporary,target);}
        catch(e){if(e?.code==='EEXIST')return verifyExisting();throw e;}
        return {created:true,path:target};
    }finally{
        try{io.unlinkSync(temporary);}catch(_){}
    }
}
module.exports={backupTrackingFile,validateTracking};
