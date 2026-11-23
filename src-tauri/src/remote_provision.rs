use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::git::credential::HttpCredential;

pub(crate) const PROVISION_RECEIPT_VERSION: u64 = 1;

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum RepositoryProvision {
    Create,
    Clone {
        url: String,
        name: String,
        credential: Option<HttpCredential>,
    },
}

impl RepositoryProvision {
    pub(crate) fn fingerprint(&self, path: &str) -> String {
        let target = match self {
            Self::Create => json!(["create", path]),
            Self::Clone { url, name, .. } => json!(["clone", path, url, name]),
        };
        format!("{:x}", Sha256::digest(target.to_string().as_bytes()))
    }
}
