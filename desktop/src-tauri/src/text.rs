//! Text from the bridge (room titles, agent names, reasons from a harness) is anyone's text. Before the tray shows it,
//! it becomes one short, inert line: no control characters, no bidi overrides or invisible formatting, no line breaks.

/// Invisible formatting that can reorder or hide what a line says, or smuggle text past a reader: every
/// Default_Ignorable_Code_Point of Unicode (bidi controls, zero-width characters, the combining grapheme joiner, the
/// Hangul and Khmer fillers, variation selectors, tag characters and their reserved neighbours), the interlinear
/// annotation controls, and the blank Braille pattern, which renders as nothing.
pub(crate) fn invisible(c: char) -> bool {
    matches!(c, '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}'..='\u{1160}' | '\u{17B4}'..='\u{17B5}' | '\u{180B}'..='\u{180F}'
        | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{2800}' | '\u{3164}' | '\u{FE00}'..='\u{FE0F}'
        | '\u{FEFF}' | '\u{FFA0}' | '\u{FFF0}'..='\u{FFFB}' | '\u{1BCA0}'..='\u{1BCA3}' | '\u{1D173}'..='\u{1D17A}' | '\u{E0000}'..='\u{E0FFF}')
}

/// One line of at most `max` characters, whitespace collapsed, cut with an ellipsis.
pub fn clean(text: &str, max: usize) -> String {
    let mut line = String::new();
    for c in text.chars().filter(|&c| !invisible(c)) {
        let c = if c.is_control() || c.is_whitespace() { ' ' } else { c };
        if c == ' ' && (line.is_empty() || line.ends_with(' ')) {
            continue;
        }
        line.push(c);
    }
    let line = line.trim_end();
    if line.chars().count() <= max {
        return line.to_string();
    }
    let cut: String = line.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// A menu label: `clean`, with `&` doubled so the menu shows it instead of making it a keyboard mnemonic.
pub fn label(text: &str, max: usize) -> String {
    clean(text, max).replace('&', "&&")
}

/// An ISO time from the bridge (`2026-10-03T14:02:11.123Z`) as `2026-10-03 14:02 UTC`.
pub fn when(iso: &str) -> String {
    let iso = clean(iso, 40);
    match (iso.get(..10), iso.get(11..16), iso.as_bytes().get(10)) {
        (Some(day), Some(time), Some(b'T')) if iso.ends_with('Z') => format!("{day} {time} UTC"),
        _ => iso,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_controls_bidi_and_line_breaks() {
        assert_eq!(clean("Plan\u{202E}gnp.exe\u{202C} room", 60), "Plangnp.exe room");
        assert_eq!(clean("a\u{2066}b\u{2069}c\u{200F}d\u{061C}e\u{FEFF}f", 60), "abcdef");
        assert_eq!(clean("line one\r\nline\u{2028}two\u{0085}\u{001B}[31m red", 60), "line one line two [31m red");
        assert_eq!(clean("  \t spaced \u{00A0}\u{3000} out  ", 60), "spaced out");
        assert_eq!(clean("\u{0007}\u{009B}", 60), "");
        // Tag characters can spell hidden ASCII; variation selectors can carry hidden bytes.
        assert_eq!(clean("ok\u{E0001}\u{E0069}\u{E0067}\u{E006E}\u{E007F} room", 60), "ok room");
        assert_eq!(clean("a\u{FE0F}b\u{FE00}c\u{E0100}d\u{E01EF}e\u{180B}", 60), "abcde");
    }

    #[test]
    fn every_default_ignorable_and_blank_filler_is_invisible() {
        // One of each class: the combining grapheme joiner, the Hangul fillers (choseong, jungseong, compatibility,
        // halfwidth), the Khmer inherent vowels, the blank Braille pattern, the word joiner's block, the reserved specials,
        // the Mongolian free variation selectors, the shorthand format controls, musical symbol format controls, and the
        // tag block's reserved tail.
        for c in ['\u{034F}', '\u{115F}', '\u{1160}', '\u{3164}', '\u{FFA0}', '\u{17B4}', '\u{17B5}', '\u{2800}', '\u{2065}', '\u{FFF0}', '\u{180F}',
            '\u{1BCA0}', '\u{1D173}', '\u{E0080}', '\u{E0FFF}'] {
            assert!(invisible(c), "U+{:04X}", c as u32);
            assert_eq!(clean(&format!("pro{c}ject"), 60), "project", "U+{:04X}", c as u32);
        }
        // Visible letters, including non-ASCII ones, are not.
        for c in ['a', 'é', 'Ж', '中', 'ㄱ', '⠁'] {
            assert!(!invisible(c), "{c}");
        }
    }

    #[test]
    fn caps_length_by_characters() {
        assert_eq!(clean("short", 5), "short");
        assert_eq!(clean("a much longer room title", 10), "a much lo…");
        assert_eq!(clean("ééééééé", 4), "ééé…");
        assert_eq!(clean(&"x".repeat(10_000), 80).chars().count(), 80);
    }

    #[test]
    fn labels_show_ampersands_and_times_read_plainly() {
        assert_eq!(label("R&D room", 40), "R&&D room");
        assert_eq!(when("2026-10-03T14:02:11.123Z"), "2026-10-03 14:02 UTC");
        assert_eq!(when("yesterday\u{202E}"), "yesterday");
    }
}
