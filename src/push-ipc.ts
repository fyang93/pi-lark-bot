import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLock, isMissing, readPrivateJson, writePrivateJson } from "./storage.ts";
import type { WorkerResponse } from "./types.ts";

const MAX_TEXT = 64_000;
export type Endpoint = { cwd: string; appId: string; token: string; socket: string; ownerToken: string };
const failure = (text: string): WorkerResponse => ({ ok: false, text });

/** One outbound-only endpoint, owned by the process holding controller.lock. */
export async function servePush(stateDir: string, cwd: string, appId: string, ownerToken: string,
  push: (text: string) => Promise<WorkerResponse>): Promise<() => Promise<void>> {
  const directory = await mkdtemp(join(tmpdir(), "pi-lark-push-"));
  await chmod(directory, 0o700);
  const endpoint: Endpoint = { cwd, appId, ownerToken, token: randomBytes(32).toString("hex"), socket: join(directory, "push.sock") };
  const manifest = join(stateDir, "push-endpoint.json");
  const server = createServer((socket) => {
    socket.setEncoding("utf8"); socket.setTimeout(45_000, () => socket.destroy());
    let input = "", handled = false;
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > MAX_TEXT + 1024) { socket.destroy(); return; }
      const end = input.indexOf("\n");
      if (end < 0) return;
      handled = true;
      void (async () => {
        let request: { token?: unknown; cwd?: unknown; appId?: unknown; text?: unknown };
        try { request = JSON.parse(input.slice(0, end)); }
        catch { socket.end(JSON.stringify(failure("推送请求格式无效。")) + "\n"); return; }
        const authorized = request.token === endpoint.token && request.cwd === cwd && request.appId === appId;
        const response = authorized && (request as { type?: unknown }).type === "ping"
          ? { ok: true, type: "status", cwd, appId, socket: endpoint.socket, ownerToken }
          : authorized && typeof request.text === "string" && Buffer.byteLength(request.text) <= MAX_TEXT
            ? await push(request.text).catch(() => failure("Lark 推送失败，请检查连接与权限。"))
            : failure("推送请求未获授权。");
        socket.end(JSON.stringify(response) + "\n");
      })();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint.socket, () => { server.off("error", reject); resolve(); });
    });
    await chmod(endpoint.socket, 0o600);
    await writePrivateJson(manifest, endpoint);
  } catch (error) {
    server.close(); await rm(directory, { recursive: true, force: true }); throw error;
  }
  return async () => {
    try {
      // Manifest is only removed by its owner; never delete a successor's endpoint.
      try {
        const current = await readPrivateJson(manifest) as Endpoint;
        if (current.token === endpoint.token) await rm(manifest);
      } catch (error) { if (!isMissing(error)) throw error; }
    } finally {
      try { await new Promise<void>((resolve) => server.close(() => resolve())); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  };
}

export async function pushViaOwner(stateDir: string, cwd: string, appId: string, text: string): Promise<WorkerResponse> {
  if (Buffer.byteLength(text) > MAX_TEXT) return failure("推送内容过长，请缩短后重试。");
  if ((await inspectLock(stateDir)).state !== "running") return failure("此项目的 Lark 机器人当前未在监听。");
  let endpoint: Endpoint;
  try { endpoint = await readPrivateJson(join(stateDir, "push-endpoint.json")) as Endpoint; }
  catch (error) { if (isMissing(error)) return failure("此项目的 Lark 机器人当前未在监听。"); throw error; }
  if (endpoint.cwd !== cwd || endpoint.appId !== appId || typeof endpoint.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(endpoint.token) || typeof endpoint.socket !== "string") return failure("Lark 推送端点与当前项目或机器人不匹配。");
  return new Promise((resolve) => {
    const socket = createConnection(endpoint.socket); let response = "", done = false;
    const finish = (value: WorkerResponse) => { if (done) return; done = true; socket.destroy(); resolve(value); };
    socket.setEncoding("utf8"); socket.setTimeout(45_000, () => finish(failure("Lark 推送端点响应超时，请检查监听会话。")));
    socket.on("error", () => finish(failure("无法连接 Lark 监听会话，请确认机器人仍在监听。")));
    socket.on("close", () => finish(failure("Lark 监听会话已断开，推送状态不确定，请检查聊天记录。")));
    socket.on("connect", () => socket.write(JSON.stringify({ token: endpoint.token, cwd, appId, text }) + "\n"));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > 4096) { finish(failure("Lark 推送响应格式无效。")); return; }
      const end = response.indexOf("\n");
      if (end < 0) return;
      try {
        const value = JSON.parse(response.slice(0, end)) as WorkerResponse;
        finish(typeof value.ok === "boolean" && typeof value.text === "string" ? value : failure("Lark 推送响应格式无效。"));
      } catch { finish(failure("Lark 推送响应格式无效。")); }
    });
  });
}
