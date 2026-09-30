use anyhow::{anyhow, Context, Result};
use std::{fs, io, path::Path};

#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, PermissionsExt};

pub fn ensure_socket_directory(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() || path == Path::new(".") {
        return Err(anyhow!("socket must be placed inside a private directory"));
    }

    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_dir() {
                return Err(anyhow!(
                    "socket parent is not a directory: {}",
                    path.display()
                ));
            }
            validate_socket_directory(path, &metadata)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path)
                .with_context(|| format!("create socket directory {}", path.display()))?;
            secure_new_socket_directory(path)
        }
        Err(error) => {
            Err(error).with_context(|| format!("inspect socket directory {}", path.display()))
        }
    }
}

#[cfg(unix)]
fn validate_socket_directory(path: &Path, metadata: &fs::Metadata) -> Result<()> {
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(anyhow!(
            "socket directory must have mode 0700: {}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_socket_directory(_path: &Path, _metadata: &fs::Metadata) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn secure_new_socket_directory(path: &Path) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("secure socket directory {}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn secure_new_socket_directory(_path: &Path) -> Result<()> {
    Ok(())
}

pub fn remove_stale_socket(path: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error).with_context(|| format!("inspect socket {}", path.display()))
        }
    };
    if !metadata.file_type().is_socket() {
        return Err(anyhow!(
            "refusing to replace non-socket path: {}",
            path.display()
        ));
    }
    fs::remove_file(path).with_context(|| format!("remove stale socket {}", path.display()))?;
    Ok(())
}

#[cfg(unix)]
pub fn secure_socket(path: &Path) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("secure unix socket {}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
pub fn secure_socket(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[cfg(unix)]
    #[test]
    fn socket_parent_permissions_are_not_changed_for_existing_directories() {
        let root = TempDir::new().expect("socket root");
        let parent = root.path().join("shared");
        fs::create_dir(&parent).expect("shared directory");
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755))
            .expect("shared permissions");
        let result = ensure_socket_directory(&parent);
        assert!(result.is_err());
        assert_eq!(
            fs::metadata(&parent).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[cfg(unix)]
    #[test]
    fn socket_parent_permissions_are_private_for_new_directories() {
        let root = TempDir::new().expect("socket root");
        let parent = root.path().join("private");
        ensure_socket_directory(&parent).expect("private directory");
        assert_eq!(
            fs::metadata(&parent).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[cfg(unix)]
    #[test]
    fn socket_parent_creates_nested_private_directory() {
        let root = TempDir::new().expect("socket root");
        let parent = root.path().join("run").join("cohub-search");
        ensure_socket_directory(&parent).expect("nested private directory");
        assert_eq!(
            fs::metadata(&parent).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}
