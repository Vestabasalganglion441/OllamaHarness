export function detectSolidityAuditIntent(message) {
  const m = String(message || "").toLowerCase();
  const mentionsSol = /\.sol\b|\bsolidity\b/.test(m);
  const mentionsAudit = /\baudit\b|vulnerabilit|exploit|\bsecurity\b|find.*bug|find.*vuln/.test(m);
  const mentionsContract = /\bcontract\b|smart contract|\bdefi\b|\berc20\b|\berc721\b/.test(m);
  return mentionsSol || (mentionsAudit && mentionsContract);
}
