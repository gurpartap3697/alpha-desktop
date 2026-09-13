//! Minimal Server-Sent Events parser for OpenAI-compatible streaming responses.
//!
//! Bytes arrive in arbitrary chunks (a line — or a multi-byte UTF-8 character —
//! may be split across chunks), so input is buffered until a full line exists.

#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    data: Option<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of bytes; returns the `data` payloads of every event completed by it.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut start = 0;
        while let Some(rel) = self.buf[start..].iter().position(|&b| b == b'\n') {
            let end = start + rel;
            let mut line = &self.buf[start..end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            let line = String::from_utf8_lossy(line).into_owned();
            self.handle_line(&line, &mut out);
            start = end + 1;
        }
        self.buf.drain(..start);
        out
    }

    /// Call at end of stream: flushes an event that wasn't terminated by a blank line.
    pub fn finish(&mut self) -> Option<String> {
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            let line = String::from_utf8_lossy(&rest).into_owned();
            let mut out = Vec::new();
            self.handle_line(line.trim_end_matches('\r'), &mut out);
            if let Some(d) = out.pop() {
                return Some(d);
            }
        }
        self.data.take()
    }

    fn handle_line(&mut self, line: &str, out: &mut Vec<String>) {
        if line.is_empty() {
            if let Some(d) = self.data.take() {
                out.push(d);
            }
            return;
        }
        if line.starts_with(':') {
            return; // comment / keep-alive
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        if field == "data" {
            match &mut self.data {
                Some(d) => {
                    d.push('\n');
                    d.push_str(value);
                }
                None => self.data = Some(value.to_string()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_events() {
        let mut p = SseParser::new();
        let out = p.push(b"data: {\"a\":1}\n\ndata: [DONE]\n\n");
        assert_eq!(out, vec!["{\"a\":1}", "[DONE]"]);
    }

    #[test]
    fn handles_split_lines_and_crlf() {
        let mut p = SseParser::new();
        assert!(p.push(b"data: hel").is_empty());
        assert!(p.push(b"lo\r\n").is_empty());
        assert_eq!(p.push(b"\r\n"), vec!["hello"]);
    }

    #[test]
    fn handles_utf8_split_across_chunks() {
        let text = "data: héllo 👋\n\n".as_bytes();
        let mut p = SseParser::new();
        let mut out = Vec::new();
        for b in text {
            out.extend(p.push(std::slice::from_ref(b)));
        }
        assert_eq!(out, vec!["héllo 👋"]);
    }

    #[test]
    fn ignores_comments_and_other_fields_and_joins_multiline_data() {
        let mut p = SseParser::new();
        let out = p.push(b": keep-alive\n\nevent: message\nid: 1\ndata: a\ndata: b\n\n");
        assert_eq!(out, vec!["a\nb"]);
    }

    #[test]
    fn accepts_data_without_a_space_and_a_split_blank_line() {
        let mut p = SseParser::new();
        assert!(p.push(b"data:{\"b\":2}\n").is_empty());
        assert_eq!(p.push(b"\ndata:[DONE]\n"), vec!["{\"b\":2}"]);
        assert_eq!(p.push(b"\n"), vec!["[DONE]"]);
        // A blank line with no data pending isn't an event.
        assert!(p.push(b"\n\n").is_empty());
    }

    #[test]
    fn finish_flushes_unterminated_event() {
        let mut p = SseParser::new();
        assert!(p.push(b"data: tail").is_empty());
        assert_eq!(p.finish().as_deref(), Some("tail"));
        assert_eq!(p.finish(), None);
    }
}
