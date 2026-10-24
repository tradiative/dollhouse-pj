import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("runtime/server",{recursive:true});
await build({entryPoints:["server/index.ts","server/connector.ts","server/vmImport.ts"],outdir:"runtime/server",bundle:true,packages:"external",platform:"node",format:"esm",target:"node24",outExtension:{".js":".mjs"},sourcemap:false});
await copyFile("package.json","runtime/package.json");await copyFile("package-lock.json","runtime/package-lock.json");
