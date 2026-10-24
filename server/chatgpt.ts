import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod, unlink } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

const AUTH = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export type Http = (url: string, init?: RequestInit) => Promise<Response>;
type Registration = { clientId: string; subject: string; email: string; issuer: string };
type Credential = Registration & { accessToken: string; refreshToken: string; idToken: string; scopes: string[]; expiresAt: number };
export type AppTransfer = { format: "tradiative.app-owned-siwc.v1"; id: string; createdAt: number; credential: Credential };
type Pending = { state: string; nonce: string; verifier: string; redirectUri: string; expires: number; registration?: Registration };
export class PlanError extends Error {
  constructor(public state: "disconnected" | "denied" | "limited" | "failed" | "cancelled" | "unsupported", message: string) { super(message); }
}
const secret = () => randomBytes(32).toString("base64url");
function same(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }

/** Only app-owned credentials from a new, explicit official OAuth flow are accepted. */
export class ChatGPTSession {
  private pending?: Pending;
  private credential?: Credential;
  private registration?: Registration;
  private hostId = "";
  private refreshJob?: Promise<string>;
  private loaded = false;
  private transfer?: AppTransfer;
  readonly csrf = secret();
  models: Array<{ slug: string; display_name: string }> = [];
  lastError = "";
  lastState = "disconnected";
  lastCompleted?: { model: string; responseId: string; at: string; sourceIds: string[]; usage: unknown; validDesign?: boolean; requestCount?: number; elapsedMs?: number; sourceHashes?: string[] };
  constructor(readonly directory: string, private http: Http, private now = () => Date.now()) {}
  private async save(name: string, value: unknown) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const target = path.join(this.directory, name), temp = target + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temp, target); await chmod(target, 0o600);
  }
  private async load() {
    if (this.loaded) return;
    const read = async (name: string) => {
      try { return JSON.parse(await readFile(path.join(this.directory, name), "utf8")); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new PlanError("failed", "앱의 보호된 인증 기록을 읽지 못했습니다."); }
    };
    const host = await read("host.json");
    if (host && (typeof host.id !== "string" || !/^urn:uuid:[a-f0-9-]{36}$/.test(host.id))) throw new PlanError("failed", "저장된 앱 호스트 식별자가 잘못되었습니다. 기존 인증 기록을 자동 교체하지 않았습니다.");
    this.hostId = typeof host?.id === "string" && /^urn:uuid:[a-f0-9-]{36}$/.test(host.id) ? host.id : "urn:uuid:" + randomUUID();
    if (!host) await this.save("host.json", { id: this.hostId });
    this.registration = await read("registration.json");
    const c = await read("credentials.json");
    if (c && typeof c.accessToken === "string" && typeof c.refreshToken === "string" && typeof c.idToken === "string" && typeof c.subject === "string" && typeof c.clientId === "string" && Array.isArray(c.scopes) && Number.isFinite(c.expiresAt) && c.subject === this.registration?.subject && c.clientId === this.registration?.clientId) this.credential = c;
    this.transfer = await read("transfer-pending.json");
    this.loaded = true;
  }
  status() {
    return { loginCompleted: Boolean(this.credential), modelAccessVerified: this.models.length > 0,
      actualRequestVerified: Boolean(this.lastCompleted), geometryVerified: this.lastCompleted?.validDesign === true, transferPending: Boolean(this.transfer), account: this.credential ? { email: this.credential.email, registration: this.credential.clientId.slice(-8) } : null,
      models: this.models, remainingUsage: null, lastState: this.lastState, error: this.lastError, lastCompleted: this.lastCompleted || null };
  }
  async initialize() { await this.load(); return this.status(); }
  async begin(origin: string) {
    await this.load();
    if (this.transfer) throw new PlanError("denied", "서버 이전을 마무리해야 합니다. PC에서 같은 갱신 세션을 다시 사용하지 않습니다.");
    const u = new URL(origin);
    if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port) throw new PlanError("unsupported", "개인 실행 로그인은 사용자 PC의 127.0.0.1 화면에서만 시작할 수 있습니다.");
    const pending: Pending = { state: secret(), nonce: secret(), verifier: secret(), redirectUri: origin + "/auth/callback", expires: this.now() + 10 * 60_000, registration: this.registration };
    this.pending = pending;
    const params = new URLSearchParams({ client_id: this.registration?.clientId || "dynamic_agent_client", ext_agent_host_id: this.hostId,
      response_type: "code", redirect_uri: pending.redirectUri, scope: SCOPES, resource: RESOURCE, state: pending.state, nonce: pending.nonce,
      code_challenge_method: "S256", code_challenge: createHash("sha256").update(pending.verifier).digest("base64url") });
    if (!this.registration) params.set("agent_name_hint", "TRADIATIVE Studio");
    if (this.credential?.idToken) params.set("id_token_hint", this.credential.idToken);
    this.lastError = "";
    return AUTH + "/api/accounts/authorize?" + params;
  }
  async callback(query: URLSearchParams) {
    const p = this.pending;
    if (!p || p.expires < this.now() || !same(query.get("state") || "", p.state)) throw new PlanError("denied", "만료되었거나 일치하지 않는 로그인 요청입니다. 다시 로그인하세요.");
    this.pending = undefined; // Valid state is single use, including a denial.
    if (query.has("error")) { this.lastState = "denied"; throw new PlanError("denied", "로그인 또는 사용량 연결 동의가 완료되지 않았습니다."); }
    const clientId = query.get("client_id") || p.registration?.clientId;
    if (!clientId || clientId === "dynamic_agent_client" || clientId.length > 200 || (p.registration && clientId !== p.registration.clientId) || !query.get("code")) throw new PlanError("denied", "로그인의 앱 등록 정보를 확인하지 못했습니다.");
    const token = await this.token(new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: query.get("code")!, code_verifier: p.verifier, redirect_uri: p.redirectUri, resource: RESOURCE }));
    if (typeof token.id_token !== "string") throw new PlanError("denied", "신원을 검증할 ID 토큰이 없습니다.");
    const metadata = await this.metadata();
    const jwksResponse = await this.http(metadata.jwks_uri, { signal: AbortSignal.timeout(15000) });
    if (!jwksResponse.ok) throw new PlanError("failed", "공식 로그인 서명 정보를 읽지 못했습니다.");
    const jwks = await jwksResponse.json() as JSONWebKeySet;
    let claims;
    try { claims = (await jwtVerify(token.id_token, createLocalJWKSet(jwks), { issuer: AUTH, audience: clientId, algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat", "nonce"], currentDate: new Date(this.now()) })).payload; }
    catch { throw new PlanError("denied", "로그인 토큰의 서명·대상·유효기간 검증에 실패했습니다."); }
    if (typeof claims.sub !== "string" || claims.nonce !== p.nonce || (p.registration && p.registration.subject !== claims.sub)) throw new PlanError("denied", "로그인 신원 또는 요청 식별자가 일치하지 않습니다.");
    const registration = { clientId, subject: claims.sub, issuer: AUTH, email: typeof claims.email === "string" ? claims.email : "ChatGPT 계정" };
    const next = this.credentials(token, registration);
    await this.save("credentials.json", next); await this.save("registration.json", registration);
    this.registration = registration; this.credential = next; this.models = []; this.lastCompleted = undefined; this.lastState = "authenticated"; this.lastError = "";
    return this.status();
  }
  private credentials(token: Record<string, unknown>, registration: Registration, previous?: Credential): Credential {
    if (typeof token.access_token !== "string" || token.token_type !== "Bearer" || typeof token.expires_in !== "number" || token.expires_in <= 0 || token.expires_in > 86400) throw new PlanError("denied", "공식 로그인 응답 형식이 맞지 않습니다.");
    const scopes = typeof token.scope === "string" ? token.scope.split(/\s+/) : previous?.scopes || [];
    const refreshToken = typeof token.refresh_token === "string" ? token.refresh_token : previous?.refreshToken;
    if (!refreshToken) throw new PlanError("denied", "갱신 가능한 로그인 권한이 없습니다.");
    return { ...registration, accessToken: token.access_token, refreshToken, idToken: typeof token.id_token === "string" ? token.id_token : previous!.idToken, scopes, expiresAt: this.now() + token.expires_in * 1000 };
  }
  private async token(form: URLSearchParams) {
    const r = await this.http(AUTH + "/api/accounts/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new PlanError(r.status === 429 ? "limited" : "denied", "로그인 교환·갱신이 완료되지 않았습니다. 별도 API로 전환하지 않았습니다.");
    return await r.json() as Record<string, unknown>;
  }
  private async metadata() {
    const r = await this.http(AUTH + "/.well-known/openid-configuration", { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new PlanError("failed", "공식 인증 메타데이터를 읽지 못했습니다.");
    const d = await r.json() as { issuer: string; jwks_uri: string; revocation_endpoint?: string };
    if (d.issuer !== AUTH || !d.jwks_uri || new URL(d.jwks_uri).origin !== AUTH || (d.revocation_endpoint && new URL(d.revocation_endpoint).origin !== AUTH)) throw new PlanError("failed", "공식 인증 메타데이터의 출처가 맞지 않습니다.");
    return d;
  }
  async accessToken() {
    await this.load();
    if (this.transfer) throw new PlanError("denied", "이 로그인은 서버로 이전 중입니다. 갱신은 대상 서버만 담당합니다.");
    if (!this.credential) throw new PlanError("disconnected", "먼저 공식 ChatGPT 로그인을 완료하세요.");
    if (!this.credential.scopes.includes("chatgpt.tokens.use.direct") || !this.credential.scopes.includes("resource.invoke")) throw new PlanError("denied", "로그인만 완료됐으며 ChatGPT 사용량 호출 권한이 없습니다. 연결 동의를 다시 확인하세요.");
    if (this.credential.expiresAt > this.now() + 60_000) return this.credential.accessToken;
    if (!this.refreshJob) this.refreshJob = (async () => {
      const current = this.credential!;
      const token = await this.token(new URLSearchParams({ grant_type: "refresh_token", client_id: current.clientId, refresh_token: current.refreshToken, resource: RESOURCE }));
      const next = this.credentials(token, current, current); await this.save("credentials.json", next); this.credential = next;
      return next.accessToken;
    })().finally(() => { this.refreshJob = undefined; });
    return this.refreshJob;
  }
  async listModels() {
    const token = await this.accessToken();
    const r = await this.http(RESOURCE + "/models", { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new PlanError(r.status === 429 ? "limited" : "denied", "이 계정의 모델 사용 권한을 확인하지 못했습니다.");
    const data = await r.json() as { models?: Array<{ slug?: string; display_name?: string; visibility?: string }> };
    if (!Array.isArray(data.models)) throw new PlanError("failed", "계정 모델 목록의 형식이 맞지 않습니다.");
    this.models = data.models.filter(m => m.visibility === "list" && typeof m.slug === "string" && typeof m.display_name === "string").slice(0, 100).map(m => ({ slug: m.slug!, display_name: m.display_name! }));
    if (!this.models.length) throw new PlanError("denied", "이 계정에서 선택 가능한 모델이 없습니다.");
    this.lastState = "model-access"; this.lastError = ""; return this.models;
  }
  async infer(model: string, input: unknown[], instructions: string, signal: AbortSignal) {
    if (!this.models.some(m => m.slug === model)) throw new PlanError("denied", "현재 계정에서 확인한 모델을 선택하세요.");
    const token = await this.accessToken();
    const r = await this.http(RESOURCE + "/responses", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ model, input, instructions, store: false, stream: true }), signal });
    if (!r.ok) throw new PlanError(r.status === 429 ? "limited" : r.status === 401 || r.status === 403 ? "denied" : "failed", "ChatGPT가 요청을 완료하지 못했습니다. 별도 API로 전환하지 않았습니다.");
    return readPlanStream(r, signal);
  }
  async logout() {
    await this.load();
    if (this.transfer) throw new PlanError("denied", "이전 중인 갱신 세션은 PC에서 해제하지 않습니다. 대상 서버의 연결 상태를 먼저 확인하세요.");
    this.pending = undefined; this.models = []; this.lastCompleted = undefined;
    let remoteRevoked = false;
    // Revoke only this app's renewable session, never a platform/Codex session.
    if (this.credential) {
      try { const metadata = await this.metadata(); if (metadata.revocation_endpoint) { const r = await this.http(metadata.revocation_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: this.credential.refreshToken, token_type_hint: "refresh_token", client_id: this.credential.clientId }).toString(), signal: AbortSignal.timeout(10000) }); remoteRevoked = r.status === 200; } } catch { /* Local sign-out still clears secrets; provider revocation is not claimed. */ }
    }
    this.credential = undefined; await unlink(path.join(this.directory, "credentials.json")).catch(e => { if (e.code !== "ENOENT") throw e; }); this.lastState = "disconnected";
    return { remoteRevoked, message: remoteRevoked ? "앱 로그인과 갱신 세션을 해제했습니다." : "앱에서 로그아웃했습니다. 원격 세션 해제는 확인하지 못했습니다. ChatGPT 설정에서 이 앱의 연결을 해제할 수 있습니다." };
  }
  /** Only the credentials issued by THIS app's validated OAuth flow. Never reads other apps. */
  async prepareTransfer(): Promise<AppTransfer> {
    await this.load();
    if (this.transfer) return this.transfer;
    await this.accessToken(); // Requires the actual plan scopes; refresh before freezing ownership.
    this.transfer = { format: "tradiative.app-owned-siwc.v1", id: randomUUID(), createdAt: this.now(), credential: { ...this.credential! } };
    await this.save("transfer-pending.json", this.transfer);
    return this.transfer;
  }
  async finishTransfer(id: string) {
    await this.load();
    if (!this.transfer || this.transfer.id !== id) throw new PlanError("denied", "서버 이전 확인이 일치하지 않습니다.");
    await unlink(path.join(this.directory, "credentials.json")).catch(e => { if(e.code !== "ENOENT") throw e; });
    await unlink(path.join(this.directory, "transfer-pending.json"));
    this.credential = undefined; this.transfer = undefined; this.models = []; this.lastCompleted = undefined; this.lastState = "transferred";
  }
  /** Called only by the offline SSH importer, never by a public HTTP endpoint. */
  async importTransfer(value: AppTransfer) {
    await this.load(); // Creates/retains THIS VM's host.json; no source host ID is imported.
    const c = value?.credential;
    if (value?.format !== "tradiative.app-owned-siwc.v1" || !/^[a-f0-9-]{36}$/.test(value.id || "") || !Number.isFinite(value.createdAt) || this.now()-value.createdAt > 600_000 || value.createdAt > this.now()+30_000 || !c || c.issuer !== AUTH || typeof c.clientId !== "string" || c.clientId === "dynamic_agent_client" || typeof c.subject !== "string" || typeof c.accessToken !== "string" || typeof c.refreshToken !== "string" || !Array.isArray(c.scopes) || !c.scopes.includes("resource.invoke") || !c.scopes.includes("chatgpt.tokens.use.direct") || !Number.isFinite(c.expiresAt) || c.expiresAt <= this.now()) throw new PlanError("denied", "이 앱의 새 로그인·사용량 동의로 발급된 유효한 이전 기록이 아닙니다.");
    if (this.registration && (c.subject !== this.registration.subject || c.clientId !== this.registration.clientId)) throw new PlanError("denied", "기존 서버의 계정·워크스페이스 등록과 다른 로그인은 가져오지 않습니다.");
    const metadata = await this.metadata(), r = await this.http(metadata.jwks_uri, {signal: AbortSignal.timeout(15000)});
    if (!r.ok) throw new PlanError("failed", "서버에서 로그인 서명을 확인하지 못했습니다.");
    try {
      const claims = (await jwtVerify(c.idToken, createLocalJWKSet(await r.json() as JSONWebKeySet), {issuer: AUTH, audience:c.clientId, algorithms:["RS256"], requiredClaims:["sub","exp","iat"],currentDate:new Date(this.now())})).payload;
      if (claims.sub !== c.subject) throw new Error("subject");
    } catch { throw new PlanError("denied", "이전하는 로그인 신원의 서명·대상·유효기간이 맞지 않습니다."); }
    const registration: Registration = {clientId:c.clientId,subject:c.subject,issuer:AUTH,email:c.email};
    await this.save("credentials.json", c); await this.save("registration.json", registration);
    this.credential = c; this.registration = registration; this.models = []; this.lastCompleted = undefined; this.lastState = "authenticated";
  }
}
export function personalPlanEnabled(env: NodeJS.ProcessEnv = process.env) { return env.TRADIATIVE_CHATGPT_MODE === "personal-local"; }
export function authDirectory(env: NodeJS.ProcessEnv = process.env) { return env.TRADIATIVE_AUTH_DIR || path.join(homedir(), ".config", "tradiative-studio"); }

/** A started HTTP stream is not completed inference. No partial JSON is returned. */
export async function readPlanStream(response: Response, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.body) throw new PlanError("failed", "AI 응답 스트림이 없습니다.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const abortRead=()=>{void reader.cancel().catch(()=>{});};
  signal?.addEventListener("abort",abortRead,{once:true});
  let buffer = "", total = 0, completed: Record<string, unknown> | undefined;
  const event = (block: string) => {
    const data = block.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let e: { type?: string; code?: string; response?: Record<string, unknown>; error?: {code?: string} };
    try { e = JSON.parse(data); } catch { throw new PlanError("failed", "AI 스트림 형식이 맞지 않습니다."); }
    if (["response.failed", "response.incomplete", "error"].includes(e.type || "")) {
      const error = e.response?.error as { code?: string } | undefined;
      const code = error?.code || e.error?.code || e.code || "";
      throw new PlanError(/usage_limit|usage_unavailable|rate_limit/.test(code) ? "limited" : "failed", "AI가 응답을 끝내지 못했습니다. 이전 형상을 보존합니다.");
    }
    if (e.type === "response.completed") { if (e.response?.status !== "completed" || typeof e.response.id !== "string" || !e.response.id) throw new PlanError("failed", "AI 최종 완료 상태·요청 식별값이 맞지 않습니다."); completed = e.response; }
  };
  try {
    while (true) {
      if (signal?.aborted) throw new PlanError("cancelled", "AI 작업을 취소했습니다.");
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new PlanError("cancelled", "AI 작업을 취소했습니다.");
      if (done) break;
      total += value.length; if (total > 6_000_000) throw new PlanError("limited", "AI 응답 크기 한도를 넘었습니다.");
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let end; while ((end = buffer.indexOf("\n\n")) >= 0) { event(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
      if (completed) { await reader.cancel(); return completed; }
    }
    buffer += decoder.decode(); if (buffer.trim()) event(buffer);
    if (!completed) throw new PlanError("failed", "최종 response.completed 없이 AI 응답이 중단됐습니다.");
    return completed;
  } finally { signal?.removeEventListener("abort",abortRead);await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
