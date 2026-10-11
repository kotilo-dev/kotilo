//! OS-specific pieces of the hook sidecar (AGENTS.md rule 7): process-tree query, the
//! desktop named-pipe connect, and the default hub data folder. Core logic in `lib.rs`
//! only calls these functions.

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::{default_data_dir, known_local_app_data, process_chain, real_connect};

#[cfg(not(windows))]
mod other;
#[cfg(not(windows))]
pub use self::other::{default_data_dir, known_local_app_data, process_chain, real_connect};
