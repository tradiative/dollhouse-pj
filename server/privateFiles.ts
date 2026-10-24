import { mkdir, chmod, open, readFile, rename, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function privateWrite(directory: string, name: string, value: unknown) {
  await mkdir(directory, {recursive:true, mode:0o700}); await chmod(directory, 0o700);
  const target=path.join(directory,name), temp=target+"."+randomUUID()+".tmp";
  const f=await open(temp,"wx",0o600);
  try { await f.writeFile(JSON.stringify(value)); await f.sync(); } finally { await f.close(); }
  await rename(temp,target);
}
export async function privateRead(directory: string, name: string) {
  const file=path.join(directory,name), info=await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (process.platform!=="win32" && (info.mode&0o077)!==0) || info.size>200_000) throw new Error("보호된 앱 기록의 권한 또는 형식이 맞지 않습니다.");
  return JSON.parse(await readFile(file,"utf8"));
}
/** One running refresh owner per auth directory; a crashed process needs operator recovery. */
export async function lockAuthDirectory(directory:string) {
  await mkdir(directory,{recursive:true,mode:0o700}); await chmod(directory,0o700);
  const file=path.join(directory,"runtime.lock"), f=await open(file,"wx",0o600);
  await f.writeFile(String(process.pid)); await f.close();
  return async()=>{await unlink(file);};
}
