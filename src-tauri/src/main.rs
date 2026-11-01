#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    twiglane_lib::mark_process_start();
    twiglane_lib::run();
}
