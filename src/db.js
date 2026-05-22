import Database from "better-sqlite3";
import path from "node:path";
import { promises as fs } from "node:fs";

export async function openDatabase(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "harness.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id)
    );
    CREATE TABLE IF NOT EXISTS memories(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      tags TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function saveMessage(db, convId, role, content, toolCalls = null, toolName = null) {
  db.prepare(
    "INSERT INTO messages(conversation_id,role,content,tool_calls,tool_name,created_at) VALUES(?,?,?,?,?,?)"
  ).run(convId, role, content || "", toolCalls ? JSON.stringify(toolCalls) : null, toolName, Date.now());
}

export function loadMessages(db, convId) {
  return db
    .prepare("SELECT role,content,tool_calls,tool_name FROM messages WHERE conversation_id=? ORDER BY id ASC")
    .all(convId)
    .map((m) => {
      const msg = { role: m.role, content: m.content || "" };
      if (m.tool_calls) msg.tool_calls = JSON.parse(m.tool_calls);
      return msg;
    });
}

export function windowedHistory(history, windowSize) {
  if (history.length <= windowSize) return history;
  const tail = history.slice(-windowSize);
  while (tail.length && tail[0].role === "tool") tail.shift();
  return tail;
}

export function loadMemoryPreamble(db, limit = 25) {
  const rows = db.prepare("SELECT key,value FROM memories ORDER BY created_at DESC LIMIT ?").all(limit);
  if (rows.length === 0) return "";
  const list = rows.map((r) => `- ${r.key}: ${r.value}`).join("\n");
  return `\n\nKnown memories (load these into context):\n${list}`;
}
