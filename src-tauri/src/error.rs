use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
    #[serde(skip)]
    pub(crate) write_unconfirmed: bool,
    #[serde(skip)]
    pub(crate) sync_effect: Option<SyncEffect>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SyncEffect {
    Completed,
    Fetched,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            generation: None,
            write_unconfirmed: false,
            sync_effect: None,
        }
    }

    pub fn with_generation(mut self, generation: u64) -> Self {
        self.generation = Some(generation);
        self
    }

    pub(crate) fn after_unconfirmed_write(mut self) -> Self {
        self.write_unconfirmed = true;
        self
    }

    pub(crate) fn after_sync_effect(mut self, effect: SyncEffect) -> Self {
        self.sync_effect = Some(effect);
        self
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}
