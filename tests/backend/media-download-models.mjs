import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const directory=fileURLToPath(new URL('../../work/media-model-cache/',import.meta.url));
await mkdir(directory,{recursive:true});
const metadata=[];
for(const kind of ['det','rec']) {
  const name=`PP-OCRv5_mobile_${kind}_onnx_infer.tar`;
  const url=`https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/${name}`;
  const response=await fetch(url,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(180000)});
  if(!response.ok)throw new Error(`官方模型下载 HTTP ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>64*1024*1024||bytes.length<1024||bytes.toString('ascii',257,262)!=='ustar')throw new Error('官方模型归档格式或大小无效');
  await writeFile(new URL(name,new URL('../../work/media-model-cache/',import.meta.url)),bytes);
  metadata.push({name,url,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  console.log(`已缓存真实官方模型 ${name} (${bytes.length} bytes)`);
}
await writeFile(new URL('../../work/media-model-cache/manifest.json',import.meta.url),JSON.stringify(metadata,null,2));
