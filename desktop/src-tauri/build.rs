fn main() {
    // The app's own commands (pair.rs, join.rs) are declared, so each needs a permission: only a window whose capability
    // grants it can call it (capabilities/pair.json grants the pairing commands to the pairing window alone, and
    // capabilities/join.json the join commands to the join window alone, capabilities/review.json the review commands
    // to the Review window alone, and capabilities/approvals.json the approvals commands to the Approvals window alone, and capabilities/notice.json the
    // notice window its own close command and nothing else).
    let commands = &[
        "home_view", "home_action", "home_window",
        "pair_view", "pair_check", "pair_verify", "pair_confirm", "pair_reject", "pair_cancel", "pair_unpair", "pair_close", "pair_open",
        "control_view", "control_check", "control_verify", "control_confirm", "control_reject", "control_close",
        "remote_view", "remote_allow", "remote_trust", "remote_revoke", "remote_close",
        "join_view", "join_confirm", "join_cancel", "join_browse",
        "review_view", "review_pause", "review_resume", "review_close",
        "approvals_view", "approvals_approve", "approvals_reject", "approvals_custom_check", "approvals_custom_make", "approvals_custom_edit", "approvals_close",
        "notice_close",
    ];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)))
        .expect("failed to run the Tauri build script");
}
