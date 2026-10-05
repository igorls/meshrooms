fn main() {
    // The app's own commands (pair.rs, join.rs) are declared, so each needs a permission: only a window whose capability
    // grants it can call it (capabilities/pair.json grants the pairing commands to the pairing window alone, and
    // capabilities/join.json the join commands to the join window alone, capabilities/review.json the review commands
    // to the Review window alone, and capabilities/approvals.json the approvals commands to the Approvals window alone).
    let commands = &[
        "pair_view", "pair_check", "pair_verify", "pair_confirm", "pair_reject", "pair_unpair", "pair_close", "pair_open",
        "join_view", "join_confirm", "join_cancel", "join_browse",
        "review_view", "review_pause", "review_resume", "review_close",
        "approvals_view", "approvals_approve", "approvals_reject", "approvals_custom_check", "approvals_custom_make", "approvals_custom_edit", "approvals_close",
    ];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)))
        .expect("failed to run the Tauri build script");
}
