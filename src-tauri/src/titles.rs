//! Conversation titles: a provisional one from the first message, then one written by the model
//! after the first answer (see "Title generation" in the plan).

use crate::chat::{self, ChatMessage};
use crate::db::TitleInput;
use crate::error::AppError;
use crate::gateway::Gateway;
use crate::models::ModelInfo;

const PROVISIONAL_CHARS: usize = 50;
const MAX_TITLE_CHARS: usize = 80;
/// Enough for a short title; a model that can't switch thinking off may spend it all on reasoning,
/// in which case the provisional title stays.
const TITLE_MAX_TOKENS: u32 = 24;
const EXCERPT_CHARS: usize = 1500;

/// The first message on one line, cut at a word boundary.
pub fn provisional(first_message: &str) -> String {
    let line = first_message.split_whitespace().collect::<Vec<_>>().join(" ");
    shorten(&line, PROVISIONAL_CHARS)
}

fn shorten(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let cut: String = text.chars().take(max).collect();
    let cut = match cut.rfind(' ') {
        Some(i) if i >= cut.len() / 2 => &cut[..i],
        _ => &cut,
    };
    format!("{}…", cut.trim_end_matches(|c: char| c.is_whitespace() || ",;:-".contains(c)))
}

fn excerpt(text: &str) -> String {
    let t: String = text.chars().take(EXCERPT_CHARS).collect();
    if t.len() < text.len() { format!("{t}…") } else { t }
}

/// A single user message: some chat templates reject a system role.
pub fn prompt(input: &TitleInput) -> Vec<ChatMessage> {
    // The instruction comes after the excerpts: small models otherwise tend to continue the chat.
    let content = format!(
        "User: {}\n\nAssistant: {}\n\n---\n\
         Write a short title for the conversation above, naming its topic, like a heading in a list of chats. \
         At most 6 words, in the conversation's language, no quotes, no punctuation at the end. \
         Reply with the title only.",
        excerpt(&input.question),
        excerpt(&input.answer),
    );
    vec![ChatMessage { role: "user".into(), content }]
}

/// The title from a model reply, or `None` if nothing usable came back.
pub fn clean(raw: &str) -> Option<String> {
    // Models that think inline put the reasoning before the title.
    let text = match raw.rfind("</think>") {
        Some(i) => &raw[i + "</think>".len()..],
        None if raw.trim_start().starts_with("<think>") => return None,
        None => raw,
    };
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut t = line.trim_start_matches(['#', '*', '-', '>', ' ']).trim();
    if t.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("title:")) {
        t = t[6..].trim();
    }
    // Markdown emphasis and code marks anywhere, quotes around the whole title.
    let t = t.replace(['*', '`'], "");
    let t = t
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '_' | '“' | '”' | '‘' | '’' | '«' | '»'))
        .trim_end_matches(['.', '!', ':', ';', ','])
        .trim();
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    (!t.is_empty()).then(|| shorten(&t, MAX_TITLE_CHARS))
}

pub async fn generate(gateway: &Gateway, key: &str, model: &ModelInfo, input: &TitleInput)
    -> Result<Option<String>, AppError> {
    let reply = chat::complete(gateway, key, model, &prompt(input), TITLE_MAX_TOKENS, Some(false)).await?;
    Ok(clean(&reply))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provisional_titles() {
        assert_eq!(provisional("  How do I\n\nparse JSON?  "), "How do I parse JSON?");
        assert_eq!(
            provisional("Explain the difference between processes and threads in operating systems"),
            "Explain the difference between processes and…"
        );
        let unbroken = "x".repeat(80);
        assert_eq!(provisional(&unbroken), format!("{}…", "x".repeat(50)));
        assert_eq!(provisional("日本語のテキスト".repeat(10).as_str()).chars().count(), 51);
    }

    #[test]
    fn cleans_model_output() {
        assert_eq!(clean("\"Parsing JSON in Rust.\"").as_deref(), Some("Parsing JSON in Rust"));
        assert_eq!(clean("Title: **Docker networking basics**\n\nExtra text").as_deref(), Some("Docker networking basics"));
        assert_eq!(clean("# Kubernetes   pod restarts").as_deref(), Some("Kubernetes pod restarts"));
        assert_eq!(clean("**Mock reply from `qwen`**").as_deref(), Some("Mock reply from qwen"));
        assert_eq!(clean("<think>\nhmm\n</think>\n\nMonads explained").as_deref(), Some("Monads explained"));
        assert_eq!(clean("<think>still thinking when max_tokens ran out"), None);
        assert_eq!(clean("  \n "), None);
        assert_eq!(clean("\"\""), None);
        assert_eq!(clean("日本語のタイトル").as_deref(), Some("日本語のタイトル"));
        assert!(clean(&"word ".repeat(40)).unwrap().ends_with('…'));
    }

    #[test]
    fn prompt_is_one_user_message_with_excerpts() {
        let input = TitleInput { model_id: "m".into(), question: "q".repeat(5000), answer: "short".into() };
        let p = prompt(&input);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].role, "user");
        assert!(p[0].content.len() < 2500);
        assert!(p[0].content.contains("Assistant: short\n"));
    }
}
