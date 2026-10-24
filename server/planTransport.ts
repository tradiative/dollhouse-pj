import { EnvHttpProxyAgent, fetch as proxyFetch } from "undici";
import type { Http } from "./chatgpt";
const dispatcher=new EnvHttpProxyAgent();
export const planHttp:Http=async(url,init)=>await proxyFetch(url,{...init,dispatcher} as Parameters<typeof proxyFetch>[1]) as unknown as globalThis.Response;
