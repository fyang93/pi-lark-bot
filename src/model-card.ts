import type { ModelSpec } from "./types.ts";

export type ModelCardAction = { action: "providers" } | { action: "models"; provider: string; page: number } | { action: "set_model"; key: string };

export function parseModelCardAction(value: unknown): ModelCardAction | undefined {
  if (!value || typeof value !== "object") return;
  const action = value as Record<string, unknown>;
  if (action.action === "providers") return { action: "providers" };
  if (action.action === "models" && typeof action.provider === "string" && Number.isSafeInteger(action.page) && Number(action.page) >= 0) return { action: "models", provider: action.provider, page: Number(action.page) };
  if (action.action === "set_model" && typeof action.key === "string") return { action: "set_model", key: action.key };
}

function button(text: string, value: ModelCardAction, primary = false): object {
  return { tag: "button", text: { tag: "plain_text", content: text }, type: primary ? "primary" : "default", behaviors: [{ type: "callback", value }] };
}

export function modelPickerCard(models: readonly ModelSpec[], current?: ModelSpec, provider?: string, page = 0): object {
  const keys = [...models].map((model) => `${model.provider}/${model.id}`).sort();
  const currentKey = current && `${current.provider}/${current.id}`;
  const elements: object[] = [{ tag: "markdown", content: `当前模型：**${currentKey ?? "未设置"}**` }];
  if (!provider) {
    const providers = [...new Set(keys.map((key) => key.split("/", 1)[0]!))];
    elements.push(...providers.map((name) => button(name, { action: "models", provider: name, page: 0 }, currentKey?.startsWith(`${name}/`))));
  } else {
    const choices = keys.filter((key) => key.startsWith(`${provider}/`));
    const pageSize = 8, pages = Math.max(1, Math.ceil(choices.length / pageSize)), safePage = Math.min(page, pages - 1);
    elements.push({ tag: "markdown", content: `提供方：**${provider}** · 第 ${safePage + 1}/${pages} 页` });
    elements.push(...choices.slice(safePage * pageSize, (safePage + 1) * pageSize).map((key) => button(key.slice(provider.length + 1), { action: "set_model", key }, key === currentKey)));
    if (safePage > 0) elements.push(button("上一页", { action: "models", provider, page: safePage - 1 }));
    if (safePage + 1 < pages) elements.push(button("下一页", { action: "models", provider, page: safePage + 1 }));
    elements.push(button("返回提供方", { action: "providers" }));
  }
  return { schema: "2.0", config: { update_multi: true }, header: { title: { tag: "plain_text", content: "选择模型" }, template: "blue" }, body: { elements } };
}

export function modelSelectedCard(model: ModelSpec): object {
  return { schema: "2.0", header: { title: { tag: "plain_text", content: "模型已切换" }, template: "green" }, body: { elements: [{ tag: "markdown", content: `当前 Pi 模型：**${model.provider}/${model.id}**` }] } };
}
