//! Original book files next to the Book records (`/api/v1/books/:id/file`): upload local
//! imports, download books synced from other devices, delete files of deleted books.

use super::api::ApiClient;
use crate::db::{books, Database};
use crate::storage::{book_file_path, materialize_book_in_dir};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// Books whose download already failed in this session (no retry loop every 5 minutes).
fn failed_downloads() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Returns human-readable problems (quota etc.) for the sync report.
pub async fn sync_book_files(db: &Database, data_dir: &Path, api: &ApiClient<'_>) -> Vec<String> {
    let mut problems = Vec::new();

    // 1. Deleted books.
    let deletes = db.read(books::pending_file_deletes).unwrap_or_default();
    for id in deletes {
        match api.delete_book_file(&id).await {
            Ok(()) => {
                let _ = db.write(|tx| books::clear_file_delete(tx, &id));
            }
            Err(e) => problems.push(format!("delete book file {id}: {e}")),
        }
    }

    let all = db.read(books::list_books).unwrap_or_default();
    for book in all {
        let original = book_file_path(data_dir, &book.id, &book.format);
        let local_path = db
            .read(|c| books::book_path_for(c, &book.id))
            .ok()
            .flatten()
            .map(std::path::PathBuf::from)
            .filter(|p| p.exists() && !p.to_string_lossy().ends_with(".chapters.txt"))
            .unwrap_or(original.clone());

        // 2. Upload local originals the server does not have yet.
        if local_path.exists() && book.file_uploaded_sha.as_deref() != book.file_sha256.as_deref() {
            let Ok(bytes) = std::fs::read(&local_path) else {
                continue;
            };
            let sha = sha256_hex(&bytes);
            match api.put_book_file(&book.id, &book.format, &sha, bytes).await {
                Ok(()) => {
                    let _ = db.write(|tx| books::mark_file_uploaded(tx, &book.id, &sha));
                }
                Err(e) if e.code == "QUOTA_EXCEEDED" => {
                    problems.push(format!(
                        "QUOTA_EXCEEDED: book file \"{}\" not uploaded ({})",
                        book.title, e.message
                    ));
                    // Do not retry every cycle; a later edit / plan change re-triggers via sha.
                    let _ = db.write(|tx| {
                        books::mark_file_uploaded(
                            tx,
                            &book.id,
                            book.file_sha256.as_deref().unwrap_or(""),
                        )
                    });
                }
                Err(e) => problems.push(format!("upload book file {}: {e}", book.id)),
            }
            continue;
        }

        // 3. Download originals of books synced from elsewhere.
        if !local_path.exists() && !original.exists() {
            if failed_downloads().lock().unwrap().contains(&book.id) {
                continue;
            }
            match api.get_book_file(&book.id).await {
                Ok(bytes) => {
                    if let Some(parent) = original.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if std::fs::write(&original, &bytes).is_ok() {
                        let _ = materialize_book_in_dir(data_dir, &book.id);
                    }
                }
                Err(e) => {
                    failed_downloads().lock().unwrap().insert(book.id.clone());
                    if e.status != Some(404) {
                        problems.push(format!("download book file {}: {e}", book.id));
                    }
                }
            }
        }
    }
    problems
}
