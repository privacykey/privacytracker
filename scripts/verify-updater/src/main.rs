// Use the same verifier and base64 envelope as tauri-plugin-updater.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        return Err(
            "usage: verify-privacytracker-updater PUBLIC_KEY_FILE SIGNATURE_FILE ARCHIVE".into(),
        );
    }
    let key = String::from_utf8(STANDARD.decode(fs::read_to_string(&args[1])?.trim())?)?;
    let signature = String::from_utf8(STANDARD.decode(fs::read_to_string(&args[2])?.trim())?)?;
    PublicKey::decode(&key)?.verify(&fs::read(&args[3])?, &Signature::decode(&signature)?, true)?;
    println!("Verified {}", args[3]);
    Ok(())
}
