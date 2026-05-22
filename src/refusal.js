export const REFUSAL_PATTERNS = [
  /\bi (?:can(?:'|no)t|am (?:un)?able to|won't|will not)\s+(?:help|assist|do that|provide|comply|generate|create|write|produce)/i,
  /\bi'?m (?:sorry|afraid)[, ]+but\b/i,
  /\bas an? (?:ai|language model|assistant)\b/i,
  /\b(?:i must|i have to|it's important to|please note that|keep in mind that|it's worth noting)\b.*\b(?:decline|refuse|caution|ethical|illegal|harmful|dangerous|responsible)/i,
  /\bagainst my (?:programming|guidelines|policy|values|principles)\b/i,
  /\bi do(?:n'|n no)t (?:feel comfortable|condone|endorse|support)\b/i,
  /\b(?:however|but|please note)[, ]+(?:i must|it's important|i should|i'd like to) (?:point out|note|emphasize|remind|caution|warn)\b/i,
];

export function looksLikeRefusal(text) {
  if (!text) return false;
  const t = text.slice(0, 1500);
  return REFUSAL_PATTERNS.some((re) => re.test(t));
}

export function stripThinkingTags(s) {
  if (!s) return s;
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^<\/?think>/gim, "").trim();
}
