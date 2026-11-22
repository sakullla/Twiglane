#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    twiglane_lib::handle_ssh_host_key_callback();
    twiglane_lib::mark_process_start();
    twiglane_lib::run();
}
