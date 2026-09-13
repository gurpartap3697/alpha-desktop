fn main() {
    // The gateway URL is baked in at compile time (see src/gateway.rs).
    println!("cargo:rerun-if-env-changed=ALPHA_GATEWAY_URL");
    tauri_build::build()
}
