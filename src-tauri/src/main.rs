#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    twiglane::mark_process_start();
    twiglane::run();
}
