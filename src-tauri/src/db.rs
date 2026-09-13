//! Chat history, stored in SQLite in the app data directory.
//!
//! Only the Rust core touches the database; the UI gets typed commands, never SQL.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};

use crate::chat::ChatMessage;
use crate::error::{AppError, ErrorKind};
use crate::titles;

/// Applied in order; `PRAGMA user_version` records how many have run. Never edit a released entry,
/// append a new one.
const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  -- pending: provisional title from the first message, a generated one follows the first answer;
  -- generated; fallback: generation failed, the provisional title stays; user: renamed by the user.
  title_status  TEXT NOT NULL DEFAULT 'pending'
                CHECK (title_status IN ('pending','generated','fallback','user')),
  model_id      TEXT NOT NULL,
  system_prompt TEXT,
  params_json   TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content           TEXT NOT NULL DEFAULT '',
  reasoning         TEXT,
  model_id          TEXT,
  status            TEXT NOT NULL DEFAULT 'complete'
                    CHECK (status IN ('streaming','complete','stopped','error')),
  error             TEXT,
  finish_reason     TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  dropped           INTEGER,
  reasoning_ms      INTEGER,
  created_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  UNIQUE (conversation_id, seq)
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"#];

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn not_found(what: &str) -> AppError {
    AppError::new(ErrorKind::NotFound, format!("This {what} no longer exists"))
}

/// Per-conversation request parameters. `None` = the model's default.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    pub reasoning: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub model_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// Search only: text around the first message that matched.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub title_status: String,
    pub model_id: String,
    pub system_prompt: Option<String>,
    pub params: Params,
    pub created_at: i64,
    pub updated_at: i64,
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub seq: i64,
    /// `user` or `assistant`.
    pub role: String,
    pub content: String,
    pub reasoning: Option<String>,
    pub model_id: Option<String>,
    /// `streaming`, `complete`, `stopped` (ended early, partial answer kept) or `error`.
    pub status: String,
    pub error: Option<AppError>,
    pub finish_reason: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    /// Older messages left out to fit the context window.
    pub dropped: Option<i64>,
    /// How long the model thought before answering.
    pub reasoning_ms: Option<i64>,
    pub created_at: i64,
    pub ended_at: Option<i64>,
}

/// What to do in a conversation before streaming an answer.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum TurnAction {
    /// Add a user message.
    Send { content: String },
    /// Replace the last answer.
    Regenerate,
    /// Change a user message, remove everything after it, and answer again.
    Edit { message_id: String, content: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRequest {
    /// `None` starts a new conversation (only with `Send`).
    pub conversation_id: Option<String>,
    pub action: TurnAction,
    pub model: String,
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub params: Params,
}

pub struct PreparedTurn {
    pub conversation: ConversationSummary,
    /// Messages created or changed, in order; the last is the new (streaming) answer.
    pub changed: Vec<Message>,
    /// What to send: system prompt, earlier successful exchanges, and the user message being answered.
    pub history: Vec<ChatMessage>,
}

impl PreparedTurn {
    pub fn answer(&self) -> &Message {
        self.changed.last().expect("a prepared turn has an answer")
    }
}

/// Final state of a streamed answer.
#[derive(Debug, Clone, Default)]
pub struct AnswerUpdate {
    pub content: String,
    pub reasoning: String,
    pub status: Option<&'static str>,
    pub error: Option<AppError>,
    pub finish_reason: Option<String>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub dropped: Option<usize>,
    pub reasoning_ms: Option<u64>,
}

pub struct TitleInput {
    pub model_id: String,
    pub question: String,
    pub answer: String,
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| AppError::new(ErrorKind::Database, format!("{}: {e}", dir.display())))?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get::<_, String>(0))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Self {
        Self::init(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn init(mut conn: Connection) -> Result<Self, AppError> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&mut conn)?;
        let recovered = recover_interrupted(&conn)?;
        if recovered > 0 {
            eprintln!("history: marked {recovered} interrupted answer(s)");
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        // A panic while holding the lock can't leave SQLite inconsistent (transactions roll back).
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// All conversations, newest first; or, with a query, those whose title or messages contain it.
    pub fn list(&self, query: &str) -> Result<Vec<ConversationSummary>, AppError> {
        let conn = self.conn();
        let query = query.trim();
        if query.is_empty() {
            let mut stmt = conn.prepare_cached(
                "SELECT id, title, model_id, created_at, updated_at FROM conversations ORDER BY updated_at DESC")?;
            let rows = stmt.query_map([], |r| summary_row(r, None))?;
            return Ok(rows.collect::<Result<_, _>>()?);
        }
        let pattern = like_pattern(query);
        let mut stmt = conn.prepare_cached(
            r#"SELECT c.id, c.title, c.model_id, c.created_at, c.updated_at,
                 (SELECT m.content FROM messages m
                   WHERE m.conversation_id = c.id AND m.content LIKE ?1 ESCAPE '\'
                   ORDER BY m.seq LIMIT 1) AS hit
               FROM conversations c
               WHERE c.title LIKE ?1 ESCAPE '\' OR hit IS NOT NULL
               ORDER BY c.updated_at DESC
               LIMIT 200"#)?;
        let rows = stmt.query_map([&pattern], |r| {
            let hit: Option<String> = r.get(5)?;
            summary_row(r, hit.and_then(|h| snippet(&h, query)))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn summary(&self, id: &str) -> Result<ConversationSummary, AppError> {
        summary(&self.conn(), id)
    }

    pub fn get(&self, id: &str) -> Result<Conversation, AppError> {
        let conn = self.conn();
        let mut conversation = conn
            .query_row(
                "SELECT id, title, title_status, model_id, system_prompt, params_json, created_at, updated_at
                 FROM conversations WHERE id = ?1",
                [id],
                |r| {
                    let params: String = r.get(5)?;
                    Ok(Conversation {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        title_status: r.get(2)?,
                        model_id: r.get(3)?,
                        system_prompt: r.get(4)?,
                        params: serde_json::from_str(&params).unwrap_or_default(),
                        created_at: r.get(6)?,
                        updated_at: r.get(7)?,
                        messages: Vec::new(),
                    })
                },
            )
            .optional()?
            .ok_or_else(|| not_found("chat"))?;
        conversation.messages = messages(&conn, id)?;
        Ok(conversation)
    }

    /// Save a conversation's model, system prompt and parameters. Doesn't reorder the list.
    pub fn update_settings(&self, id: &str, model: &str, system_prompt: Option<&str>, params: &Params)
        -> Result<(), AppError> {
        let n = self.conn().execute(
            "UPDATE conversations SET model_id = ?2, system_prompt = ?3, params_json = ?4 WHERE id = ?1",
            params![id, model, normalize_system_prompt(system_prompt), json(params)],
        )?;
        if n == 0 { Err(not_found("chat")) } else { Ok(()) }
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<ConversationSummary, AppError> {
        let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
        if title.is_empty() {
            return Err(AppError::new(ErrorKind::BadRequest, "A chat needs a title"));
        }
        let title: String = title.chars().take(200).collect();
        let conn = self.conn();
        let n = conn.execute(
            "UPDATE conversations SET title = ?2, title_status = 'user' WHERE id = ?1", params![id, title])?;
        if n == 0 {
            return Err(not_found("chat"));
        }
        summary(&conn, id)
    }

    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        self.conn().execute("DELETE FROM conversations WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Record the user's action and create the answer row (status `streaming`) in one transaction.
    pub fn prepare_turn(&self, req: &TurnRequest) -> Result<PreparedTurn, AppError> {
        if req.model.trim().is_empty() {
            return Err(AppError::new(ErrorKind::BadRequest, "No model selected"));
        }
        let now = now_ms();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let system_prompt = normalize_system_prompt(req.system_prompt.as_deref());

        let conversation_id = match &req.conversation_id {
            None => {
                let TurnAction::Send { content } = &req.action else {
                    return Err(AppError::new(ErrorKind::BadRequest, "Only a new message can start a chat"));
                };
                let id = new_id();
                tx.execute(
                    "INSERT INTO conversations (id, title, model_id, system_prompt, params_json, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                    params![id, titles::provisional(content), req.model, system_prompt, json(&req.params), now],
                )?;
                id
            }
            Some(id) => {
                let n = tx.execute(
                    "UPDATE conversations SET model_id = ?2, system_prompt = ?3, params_json = ?4, updated_at = ?5
                     WHERE id = ?1",
                    params![id, req.model, system_prompt, json(&req.params), now],
                )?;
                if n == 0 {
                    return Err(not_found("chat"));
                }
                id.clone()
            }
        };

        let mut changed = Vec::new();
        let answer_seq = match &req.action {
            TurnAction::Send { content } => {
                check_content(content)?;
                let seq: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(seq) + 1, 0) FROM messages WHERE conversation_id = ?1",
                    [&conversation_id], |r| r.get(0))?;
                let user = insert_message(&tx, &conversation_id, seq, "user", content, None, "complete", now)?;
                changed.push(user);
                seq + 1
            }
            TurnAction::Regenerate => {
                let last = tx.query_row(
                    "SELECT id, seq, role FROM messages WHERE conversation_id = ?1 ORDER BY seq DESC LIMIT 1",
                    [&conversation_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)),
                ).optional()?;
                let Some((id, seq, _)) = last.filter(|l| l.2 == "assistant") else {
                    return Err(AppError::new(ErrorKind::BadRequest, "There's no answer to regenerate"));
                };
                tx.execute("DELETE FROM messages WHERE id = ?1", [&id])?;
                seq
            }
            TurnAction::Edit { message_id, content } => {
                check_content(content)?;
                let seq: i64 = tx.query_row(
                    "SELECT seq FROM messages WHERE id = ?1 AND conversation_id = ?2 AND role = 'user'",
                    [message_id, &conversation_id], |r| r.get(0),
                ).optional()?.ok_or_else(|| not_found("message"))?;
                tx.execute("UPDATE messages SET content = ?2 WHERE id = ?1", params![message_id, content])?;
                tx.execute("DELETE FROM messages WHERE conversation_id = ?1 AND seq > ?2", params![conversation_id, seq])?;
                // Editing the first message restarts the chat, so its title should follow.
                let first: i64 = tx.query_row(
                    "SELECT MIN(seq) FROM messages WHERE conversation_id = ?1", [&conversation_id], |r| r.get(0))?;
                if first == seq {
                    tx.execute(
                        "UPDATE conversations SET title = ?2, title_status = 'pending' WHERE id = ?1 AND title_status <> 'user'",
                        params![conversation_id, titles::provisional(content)],
                    )?;
                }
                changed.push(message(&tx, message_id)?);
                seq + 1
            }
        };

        let answer = insert_message(&tx, &conversation_id, answer_seq, "assistant", "", Some(&req.model), "streaming", now)?;
        changed.push(answer);

        let earlier = messages_before(&tx, &conversation_id, answer_seq)?;
        let history = build_history(system_prompt.as_deref(), &earlier);
        let conversation = summary(&tx, &conversation_id)?;
        tx.commit()?;
        Ok(PreparedTurn { conversation, changed, history })
    }

    /// Save a streaming answer's text so far.
    pub fn save_progress(&self, id: &str, content: &str, reasoning: &str) -> Result<(), AppError> {
        self.conn().execute(
            "UPDATE messages SET content = ?2, reasoning = ?3 WHERE id = ?1 AND status = 'streaming'",
            params![id, content, non_empty(reasoning)],
        )?;
        Ok(())
    }

    /// Save an answer's final state.
    pub fn finish_answer(&self, id: &str, u: &AnswerUpdate) -> Result<(), AppError> {
        self.conn().execute(
            "UPDATE messages SET content = ?2, reasoning = ?3, status = ?4, error = ?5, finish_reason = ?6,
               prompt_tokens = ?7, completion_tokens = ?8, dropped = ?9, reasoning_ms = ?10, ended_at = ?11
             WHERE id = ?1",
            params![
                id,
                u.content,
                non_empty(&u.reasoning),
                u.status.unwrap_or("complete"),
                u.error.as_ref().map(json),
                u.finish_reason,
                u.prompt_tokens.map(|n| n as i64),
                u.completion_tokens.map(|n| n as i64),
                u.dropped.map(|n| n as i64),
                u.reasoning_ms.map(|n| n as i64),
                now_ms(),
            ],
        )?;
        Ok(())
    }

    /// The first exchange, if the conversation is waiting for a generated title and has an answer.
    pub fn title_input(&self, id: &str) -> Result<Option<TitleInput>, AppError> {
        let conn = self.conn();
        let status: Option<(String, String)> = conn.query_row(
            "SELECT title_status, model_id FROM conversations WHERE id = ?1", [id],
            |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let Some((status, model_id)) = status else { return Err(not_found("chat")) };
        if status != "pending" {
            return Ok(None);
        }
        let answer: Option<(i64, String, Option<String>)> = conn.query_row(
            "SELECT seq, content, model_id FROM messages
             WHERE conversation_id = ?1 AND role = 'assistant' AND status IN ('complete','stopped') AND content <> ''
             ORDER BY seq LIMIT 1",
            [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
        let Some((seq, answer, answer_model)) = answer else { return Ok(None) };
        let question: Option<String> = conn.query_row(
            "SELECT content FROM messages WHERE conversation_id = ?1 AND role = 'user' AND seq < ?2
             ORDER BY seq DESC LIMIT 1",
            params![id, seq], |r| r.get(0)).optional()?;
        Ok(question.map(|question| TitleInput { model_id: answer_model.unwrap_or(model_id), question, answer }))
    }

    /// Set the generated title (or, with `None`, keep the provisional one) unless the user renamed
    /// the chat in the meantime.
    pub fn resolve_title(&self, id: &str, title: Option<&str>) -> Result<ConversationSummary, AppError> {
        let conn = self.conn();
        match title {
            Some(t) => conn.execute(
                "UPDATE conversations SET title = ?2, title_status = 'generated' WHERE id = ?1 AND title_status = 'pending'",
                params![id, t])?,
            None => conn.execute(
                "UPDATE conversations SET title_status = 'fallback' WHERE id = ?1 AND title_status = 'pending'",
                [id])?,
        };
        summary(&conn, id)
    }
}

fn migrate(conn: &mut Connection) -> Result<(), AppError> {
    let version: usize = conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))? as usize;
    if version > MIGRATIONS.len() {
        return Err(AppError::new(
            ErrorKind::Database,
            "Chat history was saved by a newer version of Alph. Update the app to open it.",
        ));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

/// Answers still `streaming` at startup were cut off by the app closing.
fn recover_interrupted(conn: &Connection) -> Result<usize, AppError> {
    let error = AppError::new(ErrorKind::Interrupted, "Alph was closed before the answer finished");
    Ok(conn.execute(
        "UPDATE messages SET status = CASE WHEN content <> '' THEN 'stopped' ELSE 'error' END,
           error = ?1, ended_at = COALESCE(ended_at, ?2)
         WHERE status = 'streaming'",
        params![json(&error), now_ms()],
    )?)
}

/// Keep earlier user/answer pairs whose answer has text, then the message being answered.
/// Reasoning is never sent back, and failed exchanges are left out.
pub fn build_history(system_prompt: Option<&str>, earlier: &[Message]) -> Vec<ChatMessage> {
    let mut out = Vec::new();
    if let Some(sp) = system_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        out.push(ChatMessage { role: "system".into(), content: sp.into() });
    }
    let msg = |m: &Message| ChatMessage { role: m.role.clone(), content: m.content.clone() };
    let mut i = 0;
    while i < earlier.len() {
        let m = &earlier[i];
        if m.role == "user" {
            match earlier.get(i + 1) {
                None => out.push(msg(m)),
                Some(a) if a.role == "assistant" => {
                    if !a.content.trim().is_empty() && matches!(a.status.as_str(), "complete" | "stopped") {
                        out.push(msg(m));
                        out.push(msg(a));
                    }
                    i += 1;
                }
                Some(_) => {} // two user messages in a row: only the later one counts
            }
        }
        i += 1;
    }
    out
}

fn check_content(content: &str) -> Result<(), AppError> {
    if content.trim().is_empty() {
        return Err(AppError::new(ErrorKind::BadRequest, "The message is empty"));
    }
    Ok(())
}

fn normalize_system_prompt(sp: Option<&str>) -> Option<String> {
    sp.filter(|s| !s.trim().is_empty()).map(str::to_owned)
}

fn non_empty(s: &str) -> Option<&str> {
    (!s.is_empty()).then_some(s)
}

fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("serializable")
}

fn summary_row(r: &Row, snippet: Option<String>) -> rusqlite::Result<ConversationSummary> {
    Ok(ConversationSummary {
        id: r.get(0)?,
        title: r.get(1)?,
        model_id: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
        snippet,
    })
}

fn summary(conn: &Connection, id: &str) -> Result<ConversationSummary, AppError> {
    conn.query_row(
        "SELECT id, title, model_id, created_at, updated_at FROM conversations WHERE id = ?1",
        [id],
        |r| summary_row(r, None),
    )
    .optional()?
    .ok_or_else(|| not_found("chat"))
}

const MESSAGE_COLUMNS: &str = "id, conversation_id, seq, role, content, reasoning, model_id, status, error, \
    finish_reason, prompt_tokens, completion_tokens, dropped, reasoning_ms, created_at, ended_at";

fn message_row(r: &Row) -> rusqlite::Result<Message> {
    let error: Option<String> = r.get(8)?;
    Ok(Message {
        id: r.get(0)?,
        conversation_id: r.get(1)?,
        seq: r.get(2)?,
        role: r.get(3)?,
        content: r.get(4)?,
        reasoning: r.get(5)?,
        model_id: r.get(6)?,
        status: r.get(7)?,
        error: error.map(|e| {
            serde_json::from_str(&e).unwrap_or_else(|_| AppError::new(ErrorKind::Server, e))
        }),
        finish_reason: r.get(9)?,
        prompt_tokens: r.get(10)?,
        completion_tokens: r.get(11)?,
        dropped: r.get(12)?,
        reasoning_ms: r.get(13)?,
        created_at: r.get(14)?,
        ended_at: r.get(15)?,
    })
}

fn messages(conn: &Connection, conversation_id: &str) -> Result<Vec<Message>, AppError> {
    messages_before(conn, conversation_id, i64::MAX)
}

fn messages_before(conn: &Connection, conversation_id: &str, seq: i64) -> Result<Vec<Message>, AppError> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ?1 AND seq < ?2 ORDER BY seq"))?;
    let rows = stmt.query_map(params![conversation_id, seq], message_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn message(conn: &Connection, id: &str) -> Result<Message, AppError> {
    Ok(conn.query_row(&format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE id = ?1"), [id], message_row)?)
}

#[allow(clippy::too_many_arguments)]
fn insert_message(tx: &Transaction, conversation_id: &str, seq: i64, role: &str, content: &str,
                  model_id: Option<&str>, status: &str, now: i64) -> Result<Message, AppError> {
    let id = new_id();
    tx.execute(
        "INSERT INTO messages (id, conversation_id, seq, role, content, model_id, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, conversation_id, seq, role, content, model_id, status, now],
    )?;
    message(tx, &id)
}

/// `%query%` with LIKE wildcards in the query matched literally.
fn like_pattern(query: &str) -> String {
    let escaped = query.replace('\\', r"\\").replace('%', r"\%").replace('_', r"\_");
    format!("%{escaped}%")
}

/// A single line of text around the first match. Case-insensitive for ASCII, like SQLite's LIKE.
pub fn snippet(content: &str, query: &str) -> Option<String> {
    const BEFORE: usize = 40;
    const AFTER: usize = 90;
    // ASCII lowercasing keeps byte offsets unchanged.
    let pos = content.to_ascii_lowercase().find(&query.to_ascii_lowercase())?;
    let start = char_boundary_at_or_before(content, pos.saturating_sub(BEFORE));
    let end = char_boundary_at_or_after(content, (pos + query.len() + AFTER).min(content.len()));
    let mut text = content[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 {
        text.insert(0, '…');
    }
    if end < content.len() {
        text.push('…');
    }
    Some(text)
}

fn char_boundary_at_or_before(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn char_boundary_at_or_after(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send(conversation_id: Option<&str>, content: &str) -> TurnRequest {
        TurnRequest {
            conversation_id: conversation_id.map(str::to_owned),
            action: TurnAction::Send { content: content.into() },
            model: "qwen".into(),
            system_prompt: None,
            params: Params::default(),
        }
    }

    fn answer(db: &Db, id: &str, text: &str) {
        db.finish_answer(id, &AnswerUpdate { content: text.into(), status: Some("complete"), ..Default::default() })
            .unwrap();
    }

    fn roles(h: &[ChatMessage]) -> String {
        h.iter().map(|m| &m.role[..1]).collect()
    }

    #[test]
    fn migrates_file_once_and_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/history.sqlite3");
        let db = Db::open(&path).unwrap();
        let t = db.prepare_turn(&send(None, "hello")).unwrap();
        drop(db);
        let db = Db::open(&path).unwrap();
        assert_eq!(db.list("").unwrap()[0].id, t.conversation.id);
        let v: i64 = db.conn().pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
    }

    #[test]
    fn refuses_history_from_a_newer_app() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("h.sqlite3");
        Connection::open(&path).unwrap().pragma_update(None, "user_version", 99).unwrap();
        assert_eq!(Db::open(&path).err().unwrap().kind, ErrorKind::Database);
    }

    #[test]
    fn send_creates_conversation_and_streaming_answer() {
        let db = Db::open_in_memory();
        let t = db.prepare_turn(&TurnRequest {
            system_prompt: Some("Be brief.".into()),
            params: Params { temperature: Some(0.2), max_tokens: None, reasoning: Some(false) },
            ..send(None, "What is Rust?\nIt's a language.")
        }).unwrap();
        assert_eq!(t.conversation.title, "What is Rust? It's a language.");
        assert_eq!(t.changed.len(), 2);
        assert_eq!((t.changed[0].role.as_str(), t.changed[0].seq), ("user", 0));
        assert_eq!((t.answer().role.as_str(), t.answer().seq, t.answer().status.as_str()), ("assistant", 1, "streaming"));
        assert_eq!(roles(&t.history), "su");

        let c = db.get(&t.conversation.id).unwrap();
        assert_eq!(c.messages.len(), 2);
        assert_eq!(c.params.reasoning, Some(false));
        assert_eq!(c.system_prompt.as_deref(), Some("Be brief."));
        assert_eq!(c.title_status, "pending");
    }

    #[test]
    fn history_skips_failed_exchanges() {
        let db = Db::open_in_memory();
        let t1 = db.prepare_turn(&send(None, "one")).unwrap();
        let cid = t1.conversation.id.clone();
        answer(&db, &t1.answer().id, "first answer");
        let t2 = db.prepare_turn(&send(Some(&cid), "two")).unwrap();
        db.finish_answer(&t2.answer().id, &AnswerUpdate {
            status: Some("error"), error: Some(AppError::new(ErrorKind::Server, "boom")), ..Default::default()
        }).unwrap();
        let t3 = db.prepare_turn(&send(Some(&cid), "three")).unwrap();
        let contents: Vec<_> = t3.history.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(contents, ["one", "first answer", "three"]);

        let stored = db.get(&cid).unwrap().messages;
        assert_eq!(stored[3].error.as_ref().unwrap().kind, ErrorKind::Server);
    }

    #[test]
    fn regenerate_replaces_last_answer() {
        let db = Db::open_in_memory();
        let t = db.prepare_turn(&send(None, "hi")).unwrap();
        let cid = t.conversation.id.clone();
        answer(&db, &t.answer().id, "hello");
        let r = db.prepare_turn(&TurnRequest {
            conversation_id: Some(cid.clone()), action: TurnAction::Regenerate, model: "gemma".into(),
            system_prompt: None, params: Params::default(),
        }).unwrap();
        assert_eq!(r.changed.len(), 1);
        assert_eq!((r.answer().seq, r.answer().model_id.as_deref()), (1, Some("gemma")));
        assert_ne!(r.answer().id, t.answer().id);
        assert_eq!(roles(&r.history), "u");
        let c = db.get(&cid).unwrap();
        assert_eq!(c.messages.len(), 2);
        assert_eq!(c.model_id, "gemma");
    }

    #[test]
    fn edit_truncates_later_messages_and_retitles() {
        let db = Db::open_in_memory();
        let t1 = db.prepare_turn(&send(None, "first question")).unwrap();
        let cid = t1.conversation.id.clone();
        answer(&db, &t1.answer().id, "a1");
        let t2 = db.prepare_turn(&send(Some(&cid), "second")).unwrap();
        answer(&db, &t2.answer().id, "a2");
        db.resolve_title(&cid, Some("Generated")).unwrap();

        let edit = |message_id: &str, content: &str| TurnRequest {
            conversation_id: Some(cid.clone()),
            action: TurnAction::Edit { message_id: message_id.into(), content: content.into() },
            model: "qwen".into(), system_prompt: None, params: Params::default(),
        };
        let e = db.prepare_turn(&edit(&t2.changed[0].id, "second, edited")).unwrap();
        assert_eq!(e.changed[0].content, "second, edited");
        assert_eq!(e.answer().seq, 3);
        assert_eq!(db.get(&cid).unwrap().messages.len(), 4);
        assert_eq!(db.summary(&cid).unwrap().title, "Generated");

        let e = db.prepare_turn(&edit(&t1.changed[0].id, "a new start")).unwrap();
        assert_eq!(roles(&e.history), "u");
        let c = db.get(&cid).unwrap();
        assert_eq!(c.messages.len(), 2);
        assert_eq!((c.title.as_str(), c.title_status.as_str()), ("a new start", "pending"));

        // An answer can't be edited, and a missing message is reported.
        assert_eq!(db.prepare_turn(&edit(&e.answer().id, "x")).err().unwrap().kind, ErrorKind::NotFound);
    }

    #[test]
    fn rejects_invalid_turns() {
        let db = Db::open_in_memory();
        assert_eq!(db.prepare_turn(&send(None, "  ")).err().unwrap().kind, ErrorKind::BadRequest);
        assert_eq!(db.prepare_turn(&send(Some("nope"), "hi")).err().unwrap().kind, ErrorKind::NotFound);
        let regen = TurnRequest { action: TurnAction::Regenerate, ..send(None, "") };
        assert_eq!(db.prepare_turn(&regen).err().unwrap().kind, ErrorKind::BadRequest);
        assert!(db.list("").unwrap().is_empty(), "failed turns leave nothing behind");
    }

    #[test]
    fn progress_and_finish_are_saved() {
        let db = Db::open_in_memory();
        let t = db.prepare_turn(&send(None, "hi")).unwrap();
        let id = t.answer().id.clone();
        db.save_progress(&id, "Hel", "thinking").unwrap();
        let m = &db.get(&t.conversation.id).unwrap().messages[1];
        assert_eq!((m.content.as_str(), m.reasoning.as_deref(), m.status.as_str()), ("Hel", Some("thinking"), "streaming"));

        db.finish_answer(&id, &AnswerUpdate {
            content: "Hello".into(), reasoning: "thinking".into(), status: Some("stopped"),
            finish_reason: Some("cancelled".into()), completion_tokens: Some(2), dropped: Some(4),
            reasoning_ms: Some(1500), ..Default::default()
        }).unwrap();
        // A late progress write can't undo the final state.
        db.save_progress(&id, "Hel", "").unwrap();
        let m = &db.get(&t.conversation.id).unwrap().messages[1];
        assert_eq!((m.content.as_str(), m.status.as_str()), ("Hello", "stopped"));
        assert_eq!((m.dropped, m.reasoning_ms, m.completion_tokens), (Some(4), Some(1500), Some(2)));
        assert!(m.ended_at.is_some());
    }

    #[test]
    fn startup_marks_interrupted_answers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("h.sqlite3");
        let db = Db::open(&path).unwrap();
        let a = db.prepare_turn(&send(None, "a")).unwrap();
        let b = db.prepare_turn(&send(None, "b")).unwrap();
        db.save_progress(&a.answer().id, "partial", "").unwrap();
        drop(db);

        let db = Db::open(&path).unwrap();
        let a = &db.get(&a.conversation.id).unwrap().messages[1];
        let b = &db.get(&b.conversation.id).unwrap().messages[1];
        assert_eq!((a.status.as_str(), a.content.as_str()), ("stopped", "partial"));
        assert_eq!(b.status, "error");
        assert_eq!(a.error.as_ref().unwrap().kind, ErrorKind::Interrupted);
        assert!(b.ended_at.is_some());
    }

    #[test]
    fn list_search_rename_delete() {
        let db = Db::open_in_memory();
        let t1 = db.prepare_turn(&send(None, "Docker networking")).unwrap();
        answer(&db, &t1.answer().id, "Containers reach the host through host.docker.internal on macOS.");
        std::thread::sleep(std::time::Duration::from_millis(2));
        let t2 = db.prepare_turn(&send(None, "Write a haiku about 100% cotton_socks")).unwrap();

        let all = db.list("").unwrap();
        assert_eq!(all.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), [&t2.conversation.id, &t1.conversation.id]);

        let hits = db.list("HOST.DOCKER").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].snippet.as_deref(), Some("Containers reach the host through host.docker.internal on macOS."));
        assert_eq!(db.list("docker").unwrap()[0].snippet.as_deref(), Some("Docker networking"));
        assert_eq!(db.list("100%").unwrap().len(), 1, "% is literal");
        assert_eq!(db.list("t_n").unwrap().len(), 0, "_ is literal");
        assert_eq!(db.list("cotton_").unwrap().len(), 1);

        let renamed = db.rename(&t1.conversation.id, "  Docker   notes ").unwrap();
        assert_eq!(renamed.title, "Docker notes");
        assert!(db.rename(&t1.conversation.id, " ").is_err());
        assert_eq!(db.resolve_title(&t1.conversation.id, Some("Generated")).unwrap().title, "Docker notes",
                   "a generated title never replaces a rename");

        db.delete(&t1.conversation.id).unwrap();
        assert_eq!(db.list("").unwrap().len(), 1);
        let orphans: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1", [&t1.conversation.id], |r| r.get(0)).unwrap();
        assert_eq!(orphans, 0);
    }

    #[test]
    fn title_input_waits_for_an_answer() {
        let db = Db::open_in_memory();
        let t = db.prepare_turn(&send(None, "Explain monads")).unwrap();
        let cid = t.conversation.id.clone();
        assert!(db.title_input(&cid).unwrap().is_none());
        answer(&db, &t.answer().id, "A monad is…");
        let input = db.title_input(&cid).unwrap().unwrap();
        assert_eq!((input.question.as_str(), input.answer.as_str(), input.model_id.as_str()),
                   ("Explain monads", "A monad is…", "qwen"));
        assert_eq!(db.resolve_title(&cid, None).unwrap().title, "Explain monads");
        assert!(db.title_input(&cid).unwrap().is_none(), "only tried once");
    }

    #[test]
    fn snippets() {
        assert_eq!(snippet("hello world", "WORLD").as_deref(), Some("hello world"));
        assert_eq!(snippet("abc", "x"), None);
        let long = format!("{}needle{}", "é".repeat(100), " word".repeat(50));
        let s = snippet(&long, "needle").unwrap();
        assert!(s.starts_with('…') && s.ends_with('…') && s.contains("needle"), "{s}");
        assert_eq!(snippet("a\n\n  needle\tb", "needle").as_deref(), Some("a needle b"));
    }
}
