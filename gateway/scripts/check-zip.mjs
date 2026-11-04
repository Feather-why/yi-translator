import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { sha256 } from './optimize-assets.mjs';

/** 小于4GB的普通ZIP；校验中央目录和本地头一致，避免检查通过但解压成另一条路径。 */
export async function checkZip(filename) {
  const bytes = await readFile(filename);
  const range=(offset,size,limit=bytes.length)=>Number.isSafeInteger(offset)&&Number.isSafeInteger(size)&&offset>=0&&size>=0&&offset+size<=limit;
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--) {
    if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
  }
  if(end<0) throw new Error('ZIP 中央目录缺失');
  const count=bytes.readUInt16LE(end+10), centralSize=bytes.readUInt32LE(end+12), centralStart=bytes.readUInt32LE(end+16);
  if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||count!==bytes.readUInt16LE(end+8)||count===65535||!range(centralStart,centralSize,end)||centralStart+centralSize!==end)throw new Error('ZIP 分卷或中央目录范围无效');
  let cursor=centralStart;
  const files=new Map(), seen=new Set(), spans=[];
  for(let i=0;i<count;i++){
    if(!range(cursor,46,end)||bytes.readUInt32LE(cursor)!==0x02014b50) throw new Error('ZIP 中央目录无效');
    const flags=bytes.readUInt16LE(cursor+8), method=bytes.readUInt16LE(cursor+10), size=bytes.readUInt32LE(cursor+20), plain=bytes.readUInt32LE(cursor+24), len=bytes.readUInt16LE(cursor+28), extra=bytes.readUInt16LE(cursor+30), comment=bytes.readUInt16LE(cursor+32), offset=bytes.readUInt32LE(cursor+42), attributes=bytes.readUInt32LE(cursor+38);
    if(!range(cursor,46+len+extra+comment,end)||bytes.readUInt16LE(cursor+34)!==0)throw new Error('ZIP 目录项范围无效');
    const nameBytes=bytes.subarray(cursor+46,cursor+46+len),name=nameBytes.toString('utf8');cursor+=46+len+extra+comment;
    const directory=name.endsWith('/'), parts=(directory?name.slice(0,-1):name).split('/'), normalized=parts.join('/').toLowerCase();
    if(flags&1 || ![0,8].includes(method) || ((attributes>>>16)&0xf000)===0xa000 || !Buffer.from(name,'utf8').equals(nameBytes) || name.includes('\\') || parts.some(p=>!p||p==='.'||p==='..'||/[<>:"|?*\x00-\x1f]/.test(p)||/[ .]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))||seen.has(normalized)) throw new Error('ZIP 路径或压缩方式不合法');
    seen.add(normalized);
    if(!range(offset,30,centralStart)||bytes.readUInt32LE(offset)!==0x04034b50) throw new Error('ZIP 文件头无效');
    const localLen=bytes.readUInt16LE(offset+26),localExtra=bytes.readUInt16LE(offset+28),start=offset+30+localLen+localExtra;
    if(!range(offset,30+localLen+localExtra,centralStart)||!range(start,size,centralStart)||bytes.readUInt16LE(offset+6)!==flags||bytes.readUInt16LE(offset+8)!==method||!bytes.subarray(offset+30,offset+30+localLen).equals(nameBytes))throw new Error('ZIP 本地文件头与目录不一致');
    if(!(flags&8)&&(bytes.readUInt32LE(offset+18)!==size||bytes.readUInt32LE(offset+22)!==plain))throw new Error('ZIP 本地文件大小与目录不一致');
    if(spans.some(([left,right])=>offset<right&&start+size>left))throw new Error('ZIP 文件数据重叠');
    spans.push([offset,start+size]);
    if(directory){if(plain!==0)throw new Error('ZIP 目录包含数据');continue;}
    const packed=bytes.subarray(start,start+size), data=method===8?inflateRawSync(packed,{maxOutputLength:plain+1}):packed;
    if(data.length!==plain)throw new Error('ZIP 文件大小不匹配');files.set(name,data);
  }
  const fileNames=new Set([...files.keys()].map(name=>name.toLowerCase()));
  for(const name of seen){const parts=name.split('/');for(let i=1;i<parts.length;i++)if(fileNames.has(parts.slice(0,i).join('/')))throw new Error('ZIP 文件与目录路径冲突');}
  if(cursor!==end)throw new Error('ZIP 中央目录大小不匹配');
  const manifest=JSON.parse(files.get('release-integrity.json')?.toString()||'null');
  if(manifest?.version!==1||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw new Error('ZIP 缺少完整性清单');
  const names=[...files.keys()].filter(n=>n!=='release-integrity.json').sort();
  if(JSON.stringify(names)!==JSON.stringify(Object.keys(manifest.files).sort()))throw new Error('ZIP 文件清单不一致');
  for(const name of names){const data=files.get(name),expected=manifest.files[name];if(!expected||data.length!==expected.bytes||sha256(data)!==expected.sha256)throw new Error('ZIP 文件校验失败：'+name);}
  const hash=sha256(bytes);await writeFile(filename+'.sha256',hash+'  '+path.basename(filename)+'\n');
  return {file:filename,bytes:bytes.length,sha256:hash,checkedFiles:files.size};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){console.log(JSON.stringify(await checkZip(path.resolve(process.argv[2]))));}
