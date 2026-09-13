//! Fitting a conversation into a model's context window.
//!
//! Tokens are estimated at ~3.5 characters each; the budget reserves the output tokens plus a 10%
//! safety margin. System messages and the newest message are always sent.

use crate::chat::ChatMessage;

const CHARS_PER_TOKEN: f64 = 3.5;
/// Role markers and separators the chat template adds per message.
const PER_MESSAGE_TOKENS: usize = 4;

pub fn estimate_tokens(m: &ChatMessage) -> usize {
    (m.content.chars().count() as f64 / CHARS_PER_TOKEN).ceil() as usize + PER_MESSAGE_TOKENS
}

pub fn prompt_budget(context_window: u32, max_output_tokens: u32) -> usize {
    let window = context_window as usize;
    window.saturating_sub(max_output_tokens as usize).saturating_sub(window / 10)
}

/// The system messages plus the newest contiguous run of messages that fits the budget.
/// Returns the messages to send and how many were left out.
pub fn fit(messages: &[ChatMessage], budget: usize) -> (Vec<ChatMessage>, usize) {
    let (system, history) = split_system(messages);
    let mut used: usize = system.iter().map(estimate_tokens).sum();
    let mut start = history.len();
    for (i, m) in history.iter().enumerate().rev() {
        let cost = estimate_tokens(m);
        if start < history.len() && used + cost > budget {
            break;
        }
        used += cost;
        start = i;
    }
    let kept = starting_with_user(&history[start..]);
    let dropped = history.len() - kept.len();
    (system.iter().chain(kept).cloned().collect(), dropped)
}

/// After the server still rejected the prompt as too long: leave out the older half of the history.
/// `None` when only the newest message is left, so there's nothing more to drop.
pub fn drop_older_half(messages: &[ChatMessage]) -> Option<Vec<ChatMessage>> {
    let (system, history) = split_system(messages);
    if history.len() <= 1 {
        return None;
    }
    let keep = starting_with_user(&history[history.len() / 2..]);
    // An odd split can land on the newest message's reply boundary; always keep at least the last one.
    let keep = if keep.is_empty() { &history[history.len() - 1..] } else { keep };
    Some(system.iter().chain(keep).cloned().collect())
}

fn split_system(messages: &[ChatMessage]) -> (&[ChatMessage], &[ChatMessage]) {
    let n = messages.iter().take_while(|m| m.role == "system").count();
    messages.split_at(n)
}

/// Many chat templates (e.g. Gemma's) require the first non-system message to be from the user.
fn starting_with_user(history: &[ChatMessage]) -> &[ChatMessage] {
    match history.iter().position(|m| m.role == "user") {
        Some(i) => &history[i..],
        None => history,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage { role: role.into(), content: content.into() }
    }

    fn roles(ms: &[ChatMessage]) -> String {
        ms.iter().map(|m| &m.role[..1]).collect()
    }

    /// system + 3 turns, each message ~100 tokens.
    fn convo() -> Vec<ChatMessage> {
        let long = "x".repeat(336); // 96 + 4 = 100 tokens
        let mut v = vec![msg("system", "Be brief.")];
        for _ in 0..3 {
            v.push(msg("user", &long));
            v.push(msg("assistant", &long));
        }
        v.push(msg("user", &long));
        v
    }

    #[test]
    fn budget_reserves_output_and_margin() {
        assert_eq!(prompt_budget(8192, 2048), 8192 - 2048 - 819);
        assert_eq!(prompt_budget(100, 200), 0);
    }

    #[test]
    fn keeps_everything_that_fits() {
        let c = convo();
        let (sent, dropped) = fit(&c, 10_000);
        assert_eq!((sent.len(), dropped), (c.len(), 0));
    }

    #[test]
    fn drops_oldest_and_never_starts_with_assistant() {
        let c = convo();
        // system (7) + 4 messages (400) fit; the oldest of those is an assistant reply, so it goes too.
        let (sent, dropped) = fit(&c, 420);
        assert_eq!(roles(&sent), "suau");
        assert_eq!(dropped, 4);
        assert_eq!(sent.last().unwrap().content, c.last().unwrap().content);
    }

    #[test]
    fn newest_message_is_sent_even_if_over_budget() {
        let c = convo();
        let (sent, dropped) = fit(&c, 0);
        assert_eq!(roles(&sent), "su");
        assert_eq!(dropped, 6);
    }

    #[test]
    fn works_without_system_prompt() {
        let c = vec![msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
        assert_eq!(roles(&fit(&c, 1000).0), "uau");
    }

    #[test]
    fn retry_drops_older_half() {
        let c = convo(); // s + u a u a u a u
        let fewer = drop_older_half(&c).unwrap();
        assert_eq!(roles(&fewer), "suau");
        let fewer = drop_older_half(&fewer).unwrap();
        assert_eq!(roles(&fewer), "su");
        assert!(drop_older_half(&fewer).is_none());
    }
}
