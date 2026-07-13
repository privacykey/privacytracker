use std::fs;
use std::ptr::{self, NonNull};

use objc2_core_foundation::{CFBoolean, CFData, CFDictionary, CFRetained, CFString, CFType};
use objc2_security::{
    errSecDuplicateItem, errSecItemNotFound, errSecSuccess, kSecAttrAccount, kSecAttrService,
    kSecClass, kSecClassGenericPassword, kSecRandomDefault, kSecReturnData, kSecValueData,
    SecItemAdd, SecItemCopyMatching, SecRandomCopyBytes,
};

const ACCOUNT: &str = "privacytracker";
const SERVICE: &str = "org.privacykey.privacytracker.settings-key";
const KEY_BYTES: usize = 32;

fn opaque_dictionary(dictionary: &CFDictionary<CFType, CFType>) -> &CFDictionary {
    dictionary.as_ref()
}

fn keychain_query() -> CFRetained<CFDictionary<CFType, CFType>> {
    let account = CFString::from_str(ACCOUNT);
    let service = CFString::from_str(SERVICE);
    CFDictionary::from_slices(
        &[
            unsafe { kSecClass }.as_ref(),
            unsafe { kSecAttrAccount }.as_ref(),
            unsafe { kSecAttrService }.as_ref(),
            unsafe { kSecReturnData }.as_ref(),
        ],
        &[
            unsafe { kSecClassGenericPassword }.as_ref(),
            account.as_ref(),
            service.as_ref(),
            CFBoolean::new(true).as_ref(),
        ],
    )
}

fn read_keychain() -> Result<Option<[u8; KEY_BYTES]>, String> {
    let query = keychain_query();
    let mut raw: *const CFType = ptr::null();
    let status = unsafe { SecItemCopyMatching(opaque_dictionary(&query), &mut raw) };
    if status == errSecItemNotFound {
        return Ok(None);
    }
    if status != errSecSuccess {
        return Err(format!(
            "failed to read settings key from Keychain ({status})"
        ));
    }

    let raw = NonNull::new(raw.cast_mut())
        .ok_or_else(|| "Keychain returned an empty settings key".to_string())?;
    let value = unsafe { CFRetained::from_raw(raw) };
    let data = value
        .downcast::<CFData>()
        .map_err(|_| "Keychain settings key had the wrong type".to_string())?;
    data.to_vec()
        .try_into()
        .map(Some)
        .map_err(|_| "Keychain settings key had the wrong length".to_string())
}

fn add_keychain(key: &[u8; KEY_BYTES]) -> Result<(), i32> {
    let data = CFData::from_bytes(key);
    let attributes = CFDictionary::<CFType, CFType>::from_slices(
        &[
            unsafe { kSecClass }.as_ref(),
            unsafe { kSecAttrAccount }.as_ref(),
            unsafe { kSecAttrService }.as_ref(),
            unsafe { kSecValueData }.as_ref(),
        ],
        &[
            unsafe { kSecClassGenericPassword }.as_ref(),
            CFString::from_str(ACCOUNT).as_ref(),
            CFString::from_str(SERVICE).as_ref(),
            data.as_ref(),
        ],
    );
    let status = unsafe { SecItemAdd(opaque_dictionary(&attributes), ptr::null_mut()) };
    if status == errSecSuccess {
        Ok(())
    } else {
        Err(status)
    }
}

fn random_key() -> Result<[u8; KEY_BYTES], String> {
    let mut key = [0_u8; KEY_BYTES];
    let target = NonNull::new(key.as_mut_ptr().cast())
        .ok_or_else(|| "failed to allocate settings key".to_string())?;
    let status = unsafe { SecRandomCopyBytes(kSecRandomDefault, key.len(), target) };
    if status == 0 {
        Ok(key)
    } else {
        Err(format!("failed to generate settings key ({status})"))
    }
}

fn key_hex(key: &[u8; KEY_BYTES]) -> String {
    key.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn load_or_create(data_dir: &std::path::Path) -> Result<String, String> {
    if let Some(key) = read_keychain()? {
        return Ok(key_hex(&key));
    }

    let legacy_path = data_dir.join(".secret-key");
    let key = match fs::read(&legacy_path) {
        Ok(bytes) => bytes
            .try_into()
            .map_err(|_| "legacy settings key had the wrong length".to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => random_key()?,
        Err(error) => return Err(format!("failed to read legacy settings key: {error}")),
    };

    match add_keychain(&key) {
        Ok(()) => {}
        Err(status) if status == errSecDuplicateItem => {
            return read_keychain()?
                .map(|stored| key_hex(&stored))
                .ok_or_else(|| "settings key disappeared from Keychain".to_string());
        }
        Err(status) => {
            return Err(format!(
                "failed to store settings key in Keychain ({status})"
            ));
        }
    }

    if legacy_path.exists() {
        fs::remove_file(&legacy_path)
            .map_err(|error| format!("failed to remove legacy settings key: {error}"))?;
    }
    Ok(key_hex(&key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_hex_is_fixed_width() {
        let mut key = [0_u8; KEY_BYTES];
        key[0] = 1;
        key[31] = 255;
        assert_eq!(key_hex(&key), format!("01{}ff", "00".repeat(30)));
    }
}
