export function setupSseResponse(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  return (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

export function originGuard(allowedHosts, allowedOrigins) {
  return function (req, res, next) {
    const origin = req.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: "origin not allowed" });
    }
    const host = req.get("host");
    if (host && !allowedHosts.has(host)) {
      return res.status(403).json({ error: "host not allowed" });
    }
    next();
  };
}
