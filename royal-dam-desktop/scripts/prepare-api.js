const fs=require('fs'),path=require('path');
const source=path.join(__dirname,'..','..','royal-dam-api','src','server.js');
const target=path.join(__dirname,'..','local-api.mjs');
const servicesSource=path.join(__dirname,'..','..','royal-dam-api','src','services');
const servicesTarget=path.join(__dirname,'..','services');
const helper=path.join(__dirname,'..','node_modules','call-bind-apply-helpers');
if (fs.existsSync(helper) && fs.realpathSync(helper) !== path.resolve(helper)) {
  const realHelper=fs.realpathSync(helper);
  fs.rmSync(helper,{recursive:true,force:true});
  fs.mkdirSync(helper,{recursive:true});
  for (const file of fs.readdirSync(realHelper)) {
    const sourceFile=path.join(realHelper,file), targetFile=path.join(helper,file);
    if (fs.statSync(sourceFile).isFile()) fs.copyFileSync(sourceFile,targetFile);
  }
}
const helperSource=fs.existsSync(helper) ? fs.realpathSync(helper) : helper;
for (const packageName of ['call-bound','dunder-proto','get-intrinsic']) {
  const localHelper=path.join(__dirname,'..','node_modules',packageName,'node_modules','call-bind-apply-helpers');
  fs.mkdirSync(localHelper,{recursive:true});
  for (const file of ['index.js','package.json','actualApply.js','applyBind.js','functionApply.js','functionCall.js','reflectApply.js']) {
    fs.copyFileSync(path.join(helperSource,file),path.join(localHelper,file));
  }
}
const server = fs.readFileSync(source,'utf8').replaceAll('./services/quantityTakeoff.js','./services/quantityTakeoff.mjs').replaceAll('./services/quantityTakeoffExcel.js','./services/quantityTakeoffExcel.mjs');
fs.writeFileSync(target,server);
fs.rmSync(servicesTarget,{recursive:true,force:true});
fs.mkdirSync(servicesTarget,{recursive:true});
for (const file of ['quantityTakeoff.js','quantityTakeoffExcel.js']) fs.copyFileSync(path.join(servicesSource,file),path.join(servicesTarget,file.replace(/\.js$/,'.mjs')));
console.log('Local API copied:',target);
