export const DEFAULT_SAMPLING = {
  temperature: 0.3,
  top_p: 0.9,
  top_k: 20,
  min_p: 0,
  repeat_penalty: 1.05,
  num_ctx: 32768,
  num_predict: 4096,
};

export async function callOllamaChat({
  host,
  model,
  messages,
  tools,
  stream = false,
  signal,
  options = {},
  keepAlive = "30m",
}) {
  const body = {
    model,
    messages,
    stream,
    keep_alive: keepAlive,
    options: { ...DEFAULT_SAMPLING, ...options },
  };
  if (tools) body.tools = tools;
  const r = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
  return await r.json();
}

export async function listOllamaTags(host) {
  const r = await fetch(`${host}/api/tags`);
  if (!r.ok) throw new Error(`ollama tags ${r.status}: ${await r.text()}`);
  return await r.json();
}
